'use strict'
/* eslint-env browser */
/* globals chrome, Wappalyzer, Utils, Driver, initPromise */

// Background job: pops technology discovery tasks from the Alternative
// Discovery API, opens each target in a background tab and sends the
// detected technologies back as findings. Alternatively scans a list of URLs
// entered in the popup one by one and reports each website's technologies
// as findings without a task. Optionally also reports the
// technologies of pages the user browses as findings without a task, and
// lets the popup report the current tab's technologies on demand.

const { promisify: automationPromisify, getOption: automationGetOption } = Utils

const ALARM = 'prismappalyzer-automation'

// How often a task is fetched
const POLL_MINUTES = 0.5

// Time allowed for the page to load before collecting results anyway
const LOAD_TIMEOUT = 60 * 1000

// Time to wait after the page has loaded so scripts, XHR and JS detections
// can complete before results are collected
const SETTLE_DELAY = 30 * 1000

// Same for each website of a URL list
const URL_SETTLE_DELAY = 20 * 1000

const PROBE_TIMEOUT = 10 * 1000

const REQUEST_TIMEOUT = 30 * 1000

const TASK_TYPE = 'technology_discovery'

const TOOL = 'prismappalyzer-chrome-extension'

// Number of finished scans kept for the Automation tab
const HISTORY_SIZE = 20

// Report a browsed website again after this long
const BROWSING_REPORT_INTERVAL = 24 * 60 * 60 * 1000

// Give up on a task or URL after this many attempts (e.g. the worker was
// stopped mid-task)
const MAX_ATTEMPTS = 2

let running = false

// Tab opened for the current task or URL, excluded from browsing reports
let scanTabId = null

// Pending browsing reports by tab ID
const browsingTimers = {}

let keepAliveInterval = null

// Service settings are complete
function isConfigured(config) {
  return !!(config && config.serviceUrl && config.apiKey && config.zone)
}

// Settings are complete and automation is switched on
function isEnabled(config) {
  return isConfigured(config) && !!config.enabled
}

// Scan the URL list instead of popping tasks
function isUrlMode(config) {
  return !!config && config.mode === 'urls'
}

// Waits while calling an extension API periodically so the service worker is
// not shut down for being idle
function sleep(ms) {
  return new Promise((resolve) => {
    const keepAlive = setInterval(
      () => chrome.runtime.getPlatformInfo(() => {}),
      20 * 1000
    )

    setTimeout(() => {
      clearInterval(keepAlive)

      resolve()
    }, ms)
  })
}

const Automation = {
  async init() {
    chrome.alarms.onAlarm.addListener(({ name }) => {
      if (name === ALARM) {
        Automation.tick().catch((error) => Driver.error(error, 'automation'))
      }
    })

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.automation) {
        Automation.schedule(changes.automation.newValue).catch((error) =>
          Driver.error(error, 'automation')
        )
      }
    })

    chrome.tabs.onUpdated.addListener((tabId, { status }, tab) => {
      if (status === 'complete') {
        Automation.onBrowse(tabId, tab).catch((error) =>
          Driver.error(error, 'automation')
        )
      }
    })

    chrome.tabs.onRemoved.addListener((tabId) => {
      clearTimeout(browsingTimers[tabId])

      delete browsingTimers[tabId]
    })

    await Automation.schedule(await automationGetOption('automation'))
  },

  /**
   * Start or stop polling depending on the configuration
   * @param {Object} config
   */
  async schedule(config) {
    if (!isEnabled(config)) {
      await automationPromisify(chrome.alarms, 'clear', ALARM)

      await Automation.setStatus({
        state: isConfigured(config) ? 'stopped' : 'unconfigured',
        message: '',
      })

      return
    }

    const alarm = await automationPromisify(chrome.alarms, 'get', ALARM)

    if (!alarm) {
      chrome.alarms.create(ALARM, {
        delayInMinutes: 0.1,
        periodInMinutes: POLL_MINUTES,
      })
    }

    if (!running) {
      await Automation.setStatus({ state: 'idle', message: '' })
    }
  },

  async setStatus(status) {
    const current = await automationGetOption('automationStatus', {})

    await automationPromisify(chrome.storage.local, 'set', {
      automationStatus: { ...current, ...status, updated: Date.now() },
    })
  },

  async tick() {
    if (running) {
      return
    }

    const config = await automationGetOption('automation')

    if (!isEnabled(config)) {
      return
    }

    running = true

    try {
      await initPromise

      if (isUrlMode(config)) {
        await Automation.runUrls(config)
      } else {
        await Automation.runTask(config)
      }
    } catch (error) {
      Driver.error(error, 'automation')

      await Automation.setStatus({
        state: 'error',
        message: error.message || String(error),
      })
    } finally {
      running = false

      // Stopped while a task was running
      const latest = await automationGetOption('automation')

      if (!isEnabled(latest)) {
        await Automation.setStatus({
          state: isConfigured(latest) ? 'stopped' : 'unconfigured',
          message: '',
        })
      }
    }
  },

  /**
   * Pop a task, or resume an interrupted one, and run it
   * @param {Object} config
   */
  async runTask(config) {
    // A task left over from a previous service worker that was stopped
    // mid-task. It was already removed from the queue, so run it again.
    let current = await automationGetOption('automationTask')

    if (current) {
      if (current.tabId) {
        chrome.tabs.remove(current.tabId, () => chrome.runtime.lastError)
      }

      if (current.attempts >= MAX_ATTEMPTS) {
        Driver.error(
          new Error(`Giving up on task ${current.task.ri}: ${current.task.v}`),
          'automation'
        )

        current = null
      }
    }

    if (!current) {
      await Automation.setStatus({ state: 'polling', message: '' })

      const task = await Automation.pop(config)

      if (!task) {
        await Automation.setStatus({
          state: 'idle',
          message: 'No waiting task',
          lastPoll: Date.now(),
        })

        return
      }

      current = { task, attempts: 0 }
    }

    current.attempts += 1

    await automationPromisify(chrome.storage.local, 'set', {
      automationTask: current,
    })

    await Automation.run(config, current)

    await automationPromisify(chrome.storage.local, 'remove', 'automationTask')
  },

  /**
   * Scan the remaining URLs of the list one by one and report each website's
   * technologies. Automation switches itself off at the end of the list.
   * @param {Object} config
   */
  async runUrls(config) {
    let queue = await automationGetOption('automationQueue', {})

    // A tab left over from a previous service worker that was stopped
    // mid-scan
    if (queue.tabId) {
      chrome.tabs.remove(queue.tabId, () => chrome.runtime.lastError)
    }

    const urls = queue.urls || []

    while ((queue.index || 0) < urls.length) {
      if (!isEnabled(await automationGetOption('automation'))) {
        return
      }

      const index = queue.index || 0

      const attempts = queue.attempts || 0

      queue = { ...queue, attempts: attempts + 1, tabId: null }

      await Automation.setQueue(queue)

      if (attempts >= MAX_ATTEMPTS) {
        Driver.error(new Error(`Giving up on ${urls[index]}`), 'automation')
      } else {
        await Automation.runUrl(
          config,
          urls[index],
          `${index + 1}/${urls.length}`,
          (tabId) => Automation.setQueue({ ...queue, tabId })
        )
      }

      queue = { ...queue, index: index + 1, attempts: 0, tabId: null }

      await Automation.setQueue(queue)
    }

    // End of the list
    const latest = await automationGetOption('automation')

    await automationPromisify(chrome.storage.local, 'set', {
      automation: { ...latest, enabled: false },
    })
  },

  /**
   * Store the URL list's progress, unless the list was replaced meanwhile
   * @param {Object} queue
   */
  async setQueue(queue) {
    const current = await automationGetOption('automationQueue', {})

    if ((current.urls || []).join('\n') !== (queue.urls || []).join('\n')) {
      throw new Error('The URL list was changed')
    }

    await automationPromisify(chrome.storage.local, 'set', {
      automationQueue: queue,
    })
  },

  /**
   * Scan one URL of the list and send its technologies
   * @param {Object} config
   * @param {String} value
   * @param {String} progress
   * @param {Function} onTab
   */
  async runUrl(config, value, progress, onTab) {
    await Automation.setStatus({
      state: 'scanning',
      message: `${progress} ${value}`,
    })

    const url = await Automation.getTargetUrl({ v: value })

    let technologies = []

    let matched

    if (url) {
      technologies = await Automation.scan(url, URL_SETTLE_DELAY, onTab)
    } else {
      Driver.log(`Not accessible: ${value}`, 'automation')
    }

    // Nothing to report without technologies: there is no task to close
    if (technologies.length) {
      await Automation.setStatus({
        state: 'sending',
        message: `${progress} ${technologies.length} technologies for ${value}`,
      })
      ;({ matched } = await Automation.sendWebsite(
        config,
        new URL(url).origin,
        technologies
      ))
    }

    await Automation.addHistory({
      url: url ? new URL(url).origin : value,
      count: technologies.length,
      matched,
    })

    await Automation.setStatus({
      state: 'idle',
      message: url
        ? `${progress} Sent ${technologies.length} technologies for ${value}`
        : `${progress} Not accessible: ${value}`,
    })
  },

  async addHistory(entry) {
    const history = await automationGetOption('automationHistory', [])

    await automationPromisify(chrome.storage.local, 'set', {
      automationHistory: [{ ...entry, finished: Date.now() }, ...history].slice(
        0,
        HISTORY_SIZE
      ),
    })
  },

  async request(config, path, params, body) {
    const url = new URL(path, config.serviceUrl.replace(/\/*$/, '/'))

    Object.keys(params).forEach((key) => url.searchParams.set(key, params[key]))

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'x-auth-token': config.apiKey,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    })

    if (response.status === 204) {
      return null
    }

    const text = await response.text()

    let json = null

    try {
      json = text ? JSON.parse(text) : null
    } catch (error) {
      // Not JSON
    }

    if (!response.ok) {
      throw new Error(
        `${path} returned ${response.status}${
          json && json.message ? `: ${json.message}` : text ? `: ${text}` : ''
        }`
      )
    }

    return json
  },

  /**
   * Take one waiting technology discovery task
   * @param {Object} config
   */
  async pop(config) {
    const json = await Automation.request(config, 'v2/task/waiting/pop', {
      task_type: TASK_TYPE,
      zone: config.zone,
    })

    return json && json.data && json.data.v ? json.data : null
  },

  /**
   * Send findings for a task
   * @param {Object} config
   * @param {Array} findings
   */
  send(config, findings) {
    return Automation.request(
      config,
      'v2/task/findings',
      { zone: config.zone },
      findings
    )
  },

  /**
   * Scan a task's target and send its findings
   * @param {Object} config
   * @param {Object} current
   */
  async run(config, current) {
    const { task } = current

    await Automation.setStatus({
      state: 'scanning',
      message: task.v,
      lastTask: task.v,
      lastTaskStarted: Date.now(),
    })

    const url = await Automation.getTargetUrl(task)

    let technologies = []

    if (url) {
      technologies = await Automation.scan(url, SETTLE_DELAY, (tabId) => {
        current.tabId = tabId

        return automationPromisify(chrome.storage.local, 'set', {
          automationTask: current,
        })
      })
    } else {
      Driver.log(`Not accessible: ${task.v}`, 'automation')
    }

    const findings = technologies.length
      ? technologies.map((technology) =>
          Automation.getFinding(task, 'TECH', Automation.getProps(technology))
        )
      : [Automation.getFinding(task, 'NO_FINDING')]

    await Automation.setStatus({
      state: 'sending',
      message: `${technologies.length} technologies for ${task.v}`,
    })

    // The API accepts at most 5000 findings per request
    for (let index = 0; index < findings.length; index += 5000) {
      await Automation.send(config, findings.slice(index, index + 5000))
    }

    const { processed = 0 } = await automationGetOption('automationStatus', {})

    await Automation.addHistory({
      url: url || task.v,
      count: technologies.length,
    })

    await Automation.setStatus({
      state: 'idle',
      message: `Sent ${technologies.length} technologies for ${task.v}`,
      lastTaskFinished: Date.now(),
      lastTaskCount: technologies.length,
      processed: processed + 1,
    })
  },

  /**
   * Build the URL to open for a task. Values without a protocol are probed
   * over https, then http, like discovery nodes do.
   * @param {Object} task
   */
  async getTargetUrl(task) {
    let target = String(task.v).trim()

    if (task.iat === 'IPADDRESS' && task.av) {
      target = `${target}:${task.av}`
    }

    if (/^https?:\/\//i.test(target)) {
      return target
    }

    for (const protocol of ['https', 'http']) {
      const url = `${protocol}://${target}`

      try {
        await fetch(url, {
          method: 'HEAD',
          cache: 'no-store',
          signal: AbortSignal.timeout(PROBE_TIMEOUT),
        })

        return url
      } catch (error) {
        // Try the next protocol
      }
    }

    return null
  },

  /**
   * Open a URL in a background tab and return the detected technologies
   * @param {String} url
   * @param {Number} settleDelay
   * @param {Function} onTab called with the tab's ID once it is opened
   */
  async scan(url, settleDelay, onTab) {
    // Drop cached detections so results only reflect this visit
    const { hostname } = new URL(url)

    ;[hostname, `www.${hostname}`, hostname.replace(/^www\./, '')].forEach(
      (_hostname) => delete Driver.cache.hostnames[_hostname]
    )

    let tab

    try {
      tab = await automationPromisify(chrome.tabs, 'create', {
        url,
        active: false,
      })
    } catch (error) {
      // No browser window is open
      const { tabs } = await automationPromisify(chrome.windows, 'create', {
        url,
        focused: false,
      })

      ;[tab] = tabs
    }

    scanTabId = tab.id

    try {
      await onTab(tab.id)

      await Automation.waitForLoad(tab.id)

      await sleep(settleDelay)

      // The final URL after redirects
      const { url: finalUrl } = await automationPromisify(
        chrome.tabs,
        'get',
        tab.id
      )

      const finalHostname = /^https?:/.test(finalUrl)
        ? new URL(finalUrl).hostname
        : hostname

      const cache =
        Driver.cache.hostnames[finalHostname] ||
        Driver.cache.hostnames[hostname]

      return (
        cache && cache.detections ? Wappalyzer.resolve(cache.detections) : []
      ).filter(({ confidence }) => confidence >= 50)
    } finally {
      scanTabId = null

      chrome.tabs.remove(tab.id, () => chrome.runtime.lastError)
    }
  },

  /**
   * A tab finished loading. If browsing reports are on, send the website's
   * technologies once detection has settled.
   * @param {Number} tabId
   * @param {Object} tab
   */
  async onBrowse(tabId, { url, incognito }) {
    clearTimeout(browsingTimers[tabId])

    delete browsingTimers[tabId]

    const config = await automationGetOption('automation')

    if (
      !isEnabled(config) ||
      !config.reportBrowsing ||
      incognito ||
      tabId === scanTabId ||
      !/^https?:\/\//.test(url || '')
    ) {
      return
    }

    const { origin } = new URL(url)

    const reported = await automationGetOption('automationReported', {})

    if (reported[origin] > Date.now() - BROWSING_REPORT_INTERVAL) {
      return
    }

    clearTimeout(browsingTimers[tabId])

    browsingTimers[tabId] = setTimeout(() => {
      delete browsingTimers[tabId]

      Automation.reportBrowsing(tabId, origin).catch((error) =>
        Driver.error(error, 'automation')
      )
    }, SETTLE_DELAY)

    // Keep the service worker alive while reports are pending
    if (!keepAliveInterval) {
      keepAliveInterval = setInterval(() => {
        if (!Object.keys(browsingTimers).length) {
          clearInterval(keepAliveInterval)

          keepAliveInterval = null

          return
        }

        chrome.runtime.getPlatformInfo(() => {})
      }, 20 * 1000)
    }
  },

  /**
   * Send the technologies of a browsed website as findings without a task
   * @param {Number} tabId
   * @param {String} origin
   */
  async reportBrowsing(tabId, origin) {
    const config = await automationGetOption('automation')

    if (!isEnabled(config) || !config.reportBrowsing) {
      return
    }

    // The tab may have moved on to another website
    const tab = await automationPromisify(chrome.tabs, 'get', tabId).catch(
      () => null
    )

    if (!tab || !tab.url || !tab.url.startsWith(origin)) {
      return
    }

    if (await Driver.isDisabledDomain(tab.url)) {
      return
    }

    const technologies = Automation.getWebsiteTechnologies(origin)

    if (!technologies.length) {
      return
    }

    const { matched } = await Automation.sendWebsite(
      config,
      origin,
      technologies
    )

    const reported = await automationGetOption('automationReported', {})

    // Forget websites reported more than a day ago
    await automationPromisify(chrome.storage.local, 'set', {
      automationReported: Object.keys(reported).reduce(
        (_reported, _origin) => {
          if (reported[_origin] > Date.now() - BROWSING_REPORT_INTERVAL) {
            _reported[_origin] = reported[_origin]
          }

          return _reported
        },
        { [origin]: Date.now() }
      ),
    })

    const { count = 0 } = await automationGetOption(
      'automationBrowsingStatus',
      {}
    )

    await automationPromisify(chrome.storage.local, 'set', {
      automationBrowsingStatus: {
        count: count + 1,
        lastWebsite: origin,
        lastCount: technologies.length,
        lastMatched: matched,
        lastReported: Date.now(),
      },
    })
  },

  /**
   * Send the current technologies of a website on request from the popup
   * @param {String} url
   */
  async reportWebsite(url) {
    const config = await automationGetOption('automation')

    if (!isConfigured(config)) {
      throw new Error('Enter the service URL, API key and zone in Settings')
    }

    const { origin } = new URL(url)

    const technologies = Automation.getWebsiteTechnologies(origin)

    if (!technologies.length) {
      throw new Error('No technologies detected')
    }

    return {
      origin,
      count: technologies.length,
      ...(await Automation.sendWebsite(config, origin, technologies)),
    }
  },

  /**
   * Detected technologies of a website
   * @param {String} origin
   */
  getWebsiteTechnologies(origin) {
    const cache = Driver.cache.hostnames[new URL(origin).hostname]

    return (
      cache && cache.detections ? Wappalyzer.resolve(cache.detections) : []
    ).filter(({ confidence }) => confidence >= 50)
  },

  /**
   * Send a website's technologies as findings without a task. The API matches
   * them to websites in the ASM database by origin.
   * @param {Object} config
   * @param {String} origin
   * @param {Array} technologies
   */
  async sendWebsite(config, origin, technologies) {
    const findings = technologies.map((technology) => {
      const props = Automation.getProps(technology)

      // Only the origin is sent, not the paths visited
      delete props.detectionUrl

      return Automation.getFinding(
        { iat: 'WEBSITE', v: origin, ji: null, ri: null },
        'TECH',
        props
      )
    })

    const json = await Automation.send(config, findings)

    const unmatched =
      (json && json.data && json.data.unmatchedInputValues) || []

    return { matched: !unmatched.includes(origin) }
  },

  waitForLoad(tabId) {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timeout)

        chrome.tabs.onUpdated.removeListener(onUpdated)

        resolve()
      }

      const onUpdated = (id, { status }) => {
        if (id === tabId && status === 'complete') {
          done()
        }
      }

      const timeout = setTimeout(done, LOAD_TIMEOUT)

      chrome.tabs.onUpdated.addListener(onUpdated)

      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || (tab && tab.status === 'complete')) {
          done()
        }
      })
    })
  },

  /**
   * Finding props, matching the titan Prismappalyzer step executor
   * @param {Object} technology
   */
  getProps({
    name,
    version,
    categories,
    slug,
    cpe,
    icon,
    description,
    type,
    regex,
    value,
    url,
    match,
  }) {
    return {
      app: name,
      version: version || '-',
      type:
        categories && categories.length
          ? categories.map(({ name }) => name).join(',')
          : '-',
      slug,
      cpe,
      icon,
      description,
      detectionType: type,
      regex,
      detectionValue: value,
      detectionUrl: url,
      detectionMatch: match,
    }
  },

  /**
   * Build a finding, copying task fields to props like the Finding
   * constructor in common-core
   * @param {Object} task
   * @param {String} type
   * @param {Object} props
   */
  getFinding(task, type, props = {}) {
    const all = {
      severity: task.sv,
      inputAssetId: task.iai !== undefined ? String(task.iai) : undefined,
      inputAssetType: task.iat,
      taskType: task.tt,
      runType: task.rt,
      inputValue: task.v,
      additionalInputValue: task.av,
      ...props,
    }

    return {
      type,
      jobId: task.ji,
      runId: task.ri,
      tool: TOOL,
      // Props are a map of strings
      props: Object.keys(all).reduce((props, key) => {
        if (all[key] !== undefined && all[key] !== null && all[key] !== '') {
          props[key] = String(all[key])
        }

        return props
      }, {}),
    }
  },
}

// Called from the popup's Report button through Driver messaging
Driver.reportWebsite = (url) =>
  Automation.reportWebsite(url).catch((error) => ({
    error: error.message || String(error),
  }))

Automation.init().catch((error) => Driver.error(error, 'automation'))
