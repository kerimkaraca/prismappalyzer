'use strict'
/* eslint-env browser */
/* globals chrome, Utils */

const { open, i18n, getOption, setOption, promisify, sendMessage } = Utils

const footers = [
  {
    heading: 'Prismappalyzer CLI',
    body: 'Run the same technology detection from the command line, in scripts or in CI.',
    buttonText: 'View on GitHub',
    buttonLink: 'https://github.com/kerimkaraca/prismappalyzer',
  },
]

function setDisabledDomain(enabled) {
  const el = {
    headerSwitchEnabled: document.querySelector('.header__switch--enabled'),
    headerSwitchDisabled: document.querySelector('.header__switch--disabled'),
  }

  if (enabled) {
    el.headerSwitchEnabled.classList.add('header__switch--hidden')
    el.headerSwitchDisabled.classList.remove('header__switch--hidden')
  } else {
    el.headerSwitchEnabled.classList.remove('header__switch--hidden')
    el.headerSwitchDisabled.classList.add('header__switch--hidden')
  }
}

function getCsv() {
  let hostname = ''
  let www = false
  let https = false

  try {
    let protocol = ''

    ;({ hostname, protocol } = new URL(Popup.cache.url))

    www = hostname.startsWith('www')

    https = protocol === 'https:'

    hostname = hostname.replace(/^www\./, '')
  } catch (error) {
    // Continue
  }

  const columns = [
    'URL',
    ...Popup.cache.categories.map(({ id }) =>
      chrome.i18n.getMessage(`categoryName${id}`)
    ),
  ]

  const csv = [`"${columns.join('","')}"`]

  const filename = `prismappalyzer${
    hostname ? `_${hostname.replace('.', '-')}` : ''
  }.csv`

  const row = [`http${https ? 's' : ''}://${www ? 'www.' : ''}${hostname}`]

  row.push(
    ...Popup.cache.categories.reduce((categories, { id }) => {
      categories.push(
        csvEscape(
          Popup.cache.detections
            .filter(({ categories }) =>
              categories.some(({ id: _id }) => _id === id)
            )
            .map(({ name }) => name)
            .join(' ; ')
        )
      )

      return categories
    }, [])
  )

  csv.push(`"${row.join('","')}"`)

  return { csv, filename }
}

function csvEscape(value = '') {
  if (Array.isArray(value)) {
    value = value
      .flat()
      .slice(0, 10)
      .map((value) => csvEscape(String(value).replace(/ ; /g, ' : ')))
      .join(' ; ')
  }

  if (typeof value === 'string') {
    return value.replace(/\n/g, ' ').replace(/"/g, '""').trim()
  }

  if (typeof value === 'boolean') {
    return String(value).toUpperCase()
  }

  if (value === null) {
    return ''
  }

  return String(value).replace(/"/g, '""')
}

const Popup = {
  /**
   * Initialise popup
   */
  async init() {
    Popup.cache = {
      url: '',
      categories: [],
      detections: [],
    }

    const el = {
      body: document.body,
      detections: document.querySelector('.detections'),
      empty: document.querySelector('.empty'),
      footer: document.querySelector('.footer'),
      game: document.querySelector('.ttt-game'),
      headerSwitchDisabled: document.querySelector('.header__switch--disabled'),
      headerSwitchEnabled: document.querySelector('.header__switch--enabled'),
      headerSwitches: document.querySelectorAll('.header__switch'),
      plusDownloadLink: document.querySelector(
        '.plus-download__button .button__link'
      ),
      playGame: document.querySelector('.empty__play-game'),
      footerButtonLink: document.querySelector('.footer .button__link'),
      footerButtonText: document.querySelector('.footer .button__text'),
      footerContentBody: document.querySelector('.footer__content-body'),
      footerHeading: document.querySelector('.footer__heading'),
      footerHeadingText: document.querySelector('.footer__heading-text'),
      footerToggleClose: document.querySelector('.footer__toggle--close'),
      footerToggleOpen: document.querySelector('.footer__toggle--open'),
      headerSettings: document.querySelector('.header__settings'),
      headerThemeDark: document.querySelector('.header__theme--dark'),
      headerThemeLight: document.querySelector('.header__theme--light'),
      headerThemes: document.querySelectorAll('.header__theme'),
      issue: document.querySelector('.issue'),
      tabs: document.querySelectorAll('.tab'),
      tabItems: document.querySelectorAll('.tab-item'),
      templates: document.querySelectorAll('[data-template]'),
    }

    // Templates
    Popup.templates = Array.from(el.templates).reduce((templates, template) => {
      templates[template.dataset.template] = template.cloneNode(true)

      template.remove()

      return templates
    }, {})

    // Disabled domains
    const dynamicIcon = await getOption('dynamicIcon', false)

    if (dynamicIcon) {
      el.body.classList.add('dynamic-icon')
    }

    // Disabled domains
    let disabledDomains = await getOption('disabledDomains', [])

    // Dark mode
    const theme = await getOption('theme', 'light')

    if (theme === 'dark') {
      el.body.classList.add('dark')
      el.headerThemeLight.classList.remove('header__icon--hidden')
      el.headerThemeDark.classList.add('header__icon--hidden')
    }

    Popup.driver('getDetections').then(Popup.onGetDetections.bind(this))

    let url

    const tabs = await promisify(chrome.tabs, 'query', {
      active: true,
      currentWindow: true,
    })

    if (tabs && tabs.length) {
      ;[{ url }] = tabs

      if (url.startsWith('http')) {
        Popup.cache.url = url

        const { hostname } = new URL(url)

        setDisabledDomain(disabledDomains.includes(hostname))

        el.headerSwitchDisabled.addEventListener('click', async () => {
          disabledDomains = disabledDomains.filter(
            (_hostname) => _hostname !== hostname
          )

          await setOption('disabledDomains', disabledDomains)

          setDisabledDomain(false)

          Popup.driver('getDetections').then(Popup.onGetDetections.bind(this))
        })

        el.headerSwitchEnabled.addEventListener('click', async () => {
          disabledDomains.push(hostname)

          await setOption('disabledDomains', disabledDomains)

          setDisabledDomain(true)

          Popup.driver('getDetections').then(Popup.onGetDetections.bind(this))
        })
      } else {
        for (const headerSwitch of el.headerSwitches) {
          headerSwitch.classList.add('header__switch--hidden')
        }
      }
    }

    // Header
    el.headerSettings.addEventListener('click', () =>
      chrome.runtime.openOptionsPage()
    )

    // Theme
    el.headerThemes.forEach((headerTheme) =>
      headerTheme.addEventListener('click', async () => {
        const theme = await getOption('theme', 'light')

        el.body.classList[theme === 'dark' ? 'remove' : 'add']('dark')
        el.body.classList[theme === 'dark' ? 'add' : 'remove']('light')
        el.headerThemeDark.classList[theme === 'dark' ? 'remove' : 'add'](
          'header__icon--hidden'
        )
        el.headerThemeLight.classList[theme === 'dark' ? 'add' : 'remove'](
          'header__icon--hidden'
        )

        await setOption('theme', theme === 'dark' ? 'light' : 'dark')
      })
    )

    // Tabs
    el.tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => {
        el.tabs.forEach((tab) => tab.classList.remove('tab--active'))
        el.tabItems.forEach((item) => item.classList.add('tab-item--hidden'))

        tab.classList.add('tab--active')
        el.tabItems[index].classList.remove('tab-item--hidden')

        // Export, Report and the footer only apply to the Technologies tab
        el.body.classList[index ? 'add' : 'remove']('secondary-tab-active')
      })
    })

    // Automation
    await Popup.initAutomation()

    // Download
    el.plusDownloadLink.addEventListener('click', Popup.downloadCsv)

    // Footer
    const item =
      footers[
        Math.round(Math.random())
          ? 0
          : Math.round(Math.random() * (footers.length - 1))
      ]

    el.footerHeadingText.textContent = item.heading
    el.footerContentBody.textContent = item.body
    el.footerButtonText.textContent = item.buttonText
    el.footerButtonLink.href = item.buttonLink

    const collapseFooter = await getOption('collapseFooter', false)

    if (collapseFooter) {
      el.footer.classList.add('footer--collapsed')
      el.footerToggleClose.classList.add('footer__toggle--hidden')
      el.footerToggleOpen.classList.remove('footer__toggle--hidden')
    }

    el.footerHeading.addEventListener('click', async () => {
      const collapsed = el.footer.classList.contains('footer--collapsed')

      el.footer.classList[collapsed ? 'remove' : 'add']('footer--collapsed')
      el.footerToggleClose.classList[collapsed ? 'remove' : 'add'](
        'footer__toggle--hidden'
      )
      el.footerToggleOpen.classList[collapsed ? 'add' : 'remove'](
        'footer__toggle--hidden'
      )

      await setOption('collapseFooter', !collapsed)
    })

    Array.from(document.querySelectorAll('a[href^="http"]')).forEach((a) => {
      a.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopImmediatePropagation()

        const { version } = chrome.runtime.getManifest()

        open(
          a.href
            .replace(/__URL__/g, encodeURIComponent(url))
            .replace(/__VERSION__/g, version)
        )

        return false
      })
    })

    // Game
    el.playGame.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopImmediatePropagation()

      el.playGame.classList.add('empty__play-game--hidden')
      el.game.classList.remove('ttt-game--hidden')
    })

    // Apply internationalization
    i18n()

    Popup.cache.categories = await Popup.driver('getCategories')
  },

  /**
   * Automation and Settings tabs, and the Report button
   */
  async initAutomation() {
    const el = {
      toggle: document.querySelector('.automation__toggle'),
      automation: document.querySelector('.automation'),
      modes: Array.from(document.querySelectorAll('.automation__mode')),
      urlList: document.querySelector('.automation__url-list'),
      urlMessage: document.querySelector(
        '.automation__urls .automation__error'
      ),
      progress: document.querySelector('.automation__progress'),
      reportBrowsing: document.querySelector('.automation__report-browsing'),
      settings: document.querySelector('.settings'),
      serviceUrl: document.querySelector('.settings__service-url'),
      apiKey: document.querySelector('.settings__api-key'),
      zone: document.querySelector('.settings__zone'),
      settingsMessage: document.querySelector('.settings__message'),
      report: document.querySelector('.report__button'),
      reportMessage: document.querySelector('.report-message'),
    }

    const config = await getOption('automation', {})

    el.serviceUrl.value = config.serviceUrl || ''
    el.apiKey.value = config.apiKey || ''
    el.zone.value = config.zone || ''
    el.reportBrowsing.checked = !!config.reportBrowsing
    el.urlList.value =
      (await getOption('automationQueue', {})).urls?.join('\n') || ''

    // Merge changes into the stored configuration
    const update = async (changes) =>
      setOption('automation', {
        ...(await getOption('automation', {})),
        ...changes,
      })

    const showMessage = (node, message, error = false) => {
      node.textContent = message
      node.classList[message ? 'remove' : 'add'](`${node.classList[0]}--hidden`)
      node.classList[error ? 'add' : 'remove'](`${node.classList[0]}--error`)
    }

    // Settings
    el.settings.addEventListener('submit', async (event) => {
      event.preventDefault()

      const serviceUrl = el.serviceUrl.value.trim()
      const apiKey = el.apiKey.value.trim()
      const zone = el.zone.value.trim()

      if (serviceUrl && !/^https?:\/\/[^/]+/i.test(serviceUrl)) {
        return showMessage(
          el.settingsMessage,
          'Service URL must start with http:// or https://',
          true
        )
      }

      if (zone && !/^\w+$/.test(zone)) {
        return showMessage(
          el.settingsMessage,
          'Zone may only contain letters, digits and _',
          true
        )
      }

      await update({ serviceUrl, apiKey, zone })

      showMessage(el.settingsMessage, 'Saved')
    })

    el.settings.addEventListener('input', () =>
      showMessage(el.settingsMessage, '')
    )

    // URL list, one website per line. Saving a different list restarts it
    // from the first website.
    const saveUrls = async () => {
      const lines = el.urlList.value
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)

      const invalid = lines.find((line) => {
        try {
          const { protocol, hostname } = new URL(
            /^[a-z][a-z\d+.-]*:\/\//i.test(line) ? line : `https://${line}`
          )

          return (
            /\s/.test(line) ||
            !/^https?:$/.test(protocol) ||
            !/^([a-z\d-]+\.)*[a-z\d-]+$|^\[[\da-f:.]+\]$/i.test(hostname)
          )
        } catch (error) {
          return true
        }
      })

      if (invalid) {
        showMessage(el.urlMessage, `Not a website URL: ${invalid}`, true)

        return null
      }

      showMessage(el.urlMessage, '')

      const urls = [...new Set(lines)]

      const queue = await getOption('automationQueue', {})

      if ((queue.urls || []).join('\n') !== urls.join('\n')) {
        await setOption('automationQueue', { urls, index: 0 })
      }

      return urls
    }

    el.urlList.addEventListener('change', saveUrls)

    el.urlList.addEventListener('input', () => showMessage(el.urlMessage, ''))

    el.modes.forEach((input) =>
      input.addEventListener('change', () => update({ mode: input.value }))
    )

    // Automation
    el.toggle.addEventListener('click', async () => {
      const config = await getOption('automation', {})

      if (!config.enabled && config.mode === 'urls') {
        const urls = await saveUrls()

        if (!urls) {
          return
        }

        if (!urls.length) {
          return showMessage(el.urlMessage, 'Enter at least one URL', true)
        }

        // Scan the list again once it was finished
        const queue = await getOption('automationQueue', {})

        if ((queue.index || 0) >= urls.length) {
          await setOption('automationQueue', { urls, index: 0 })
        }
      }

      await update({ enabled: !config.enabled })
    })

    el.reportBrowsing.addEventListener('change', () =>
      update({ reportBrowsing: el.reportBrowsing.checked })
    )

    // Report
    el.report.addEventListener('click', async () => {
      if (el.report.classList.contains('report__button--busy')) {
        return
      }

      el.report.classList.add('report__button--busy')

      showMessage(el.reportMessage, 'Sending…')

      try {
        const { error, origin, count, matched } = await Popup.driver(
          'reportWebsite',
          Popup.cache.url
        )

        if (error) {
          showMessage(el.reportMessage, `Not sent: ${error}`, true)
        } else {
          showMessage(
            el.reportMessage,
            matched
              ? `Sent ${count} technologies for ${origin}`
              : `Sent ${count} technologies, but ${origin} is not a website in ASM, so nothing was recorded`,
            !matched
          )
        }
      } catch (error) {
        showMessage(el.reportMessage, `Not sent: ${error.message}`, true)
      }

      el.report.classList.remove('report__button--busy')
    })

    const render = async () => {
      const config = await getOption('automation', {})

      const configured = !!(config.serviceUrl && config.apiKey && config.zone)

      el.toggle.textContent = chrome.i18n.getMessage(
        config.enabled ? 'automationStop' : 'automationStart'
      )
      el.toggle.disabled = !configured && !config.enabled

      const mode = config.mode === 'urls' ? 'urls' : 'tasks'

      el.automation.classList.remove('automation--tasks', 'automation--urls')
      el.automation.classList.add(`automation--${mode}`)

      el.modes.forEach((input) => {
        input.checked = input.value === mode
        input.disabled = !!config.enabled
      })

      el.urlList.disabled = !!config.enabled

      el.report.classList[configured ? 'remove' : 'add'](
        'report__button--hidden'
      )
    }

    await render()

    Popup.onAutomationStatus(await getOption('automationStatus', {}))
    Popup.onBrowsingStatus(await getOption('automationBrowsingStatus', {}))
    Popup.onAutomationHistory(await getOption('automationHistory', []))
    Popup.onAutomationQueue(await getOption('automationQueue', {}))

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') {
        return
      }

      if (changes.automation) {
        render()
      }

      if (changes.automationStatus) {
        Popup.onAutomationStatus(changes.automationStatus.newValue || {})
      }

      if (changes.automationBrowsingStatus) {
        Popup.onBrowsingStatus(changes.automationBrowsingStatus.newValue || {})
      }

      if (changes.automationQueue) {
        Popup.onAutomationQueue(changes.automationQueue.newValue || {})
      }

      if (changes.automationHistory) {
        Popup.onAutomationHistory(changes.automationHistory.newValue || [])
      }
    })
  },

  onAutomationQueue({ urls = [], index = 0 }) {
    document.querySelector('.automation__progress').textContent = urls.length
      ? `Scanned ${Math.min(index, urls.length)} of ${urls.length} websites`
      : ''
  },

  onAutomationStatus({ state = 'unconfigured', message }) {
    const el = {
      status: document.querySelector('.automation-status'),
      text: document.querySelector('.automation-status__text'),
      message: document.querySelector('.automation-status__message'),
    }

    const states = {
      unconfigured: 'Off: complete the Settings tab first',
      stopped: 'Off',
      idle: 'On: waiting for the next task',
      polling: 'On: fetching a task',
      scanning: 'On: scanning',
      sending: 'On: sending results',
      error: 'On: last attempt failed',
    }

    const off = state === 'stopped' || state === 'unconfigured'

    el.status.dataset.state = off ? 'stopped' : state
    el.text.textContent = states[state] || state
    el.message.textContent = off ? '' : message || ''
  },

  onBrowsingStatus({
    count,
    lastWebsite,
    lastCount,
    lastMatched,
    lastReported,
  }) {
    document.querySelector('.automation-status__browsing').textContent = count
      ? `Browsed websites sent: ${count} · Last: ${lastWebsite} (${lastCount} technologies${
          lastMatched ? '' : ', not in ASM'
        }, ${new Date(lastReported).toLocaleTimeString()})`
      : ''
  },

  onAutomationHistory(history) {
    const el = {
      table: document.querySelector('.automation-history'),
      body: document.querySelector('.automation-history tbody'),
      empty: document.querySelector('.automation-history__empty'),
    }

    el.table.classList[history.length ? 'remove' : 'add'](
      'automation-history--hidden'
    )
    el.empty.classList[history.length ? 'add' : 'remove'](
      'automation-history__empty--hidden'
    )

    el.body.replaceChildren(
      ...history.map(({ url, finished, count, matched }) => {
        const row = document.createElement('tr')

        const date = new Date(finished)

        ;[
          url,
          date.toDateString() === new Date().toDateString()
            ? date.toLocaleTimeString()
            : date.toLocaleString(),
          matched === false ? `${count}, not in ASM` : String(count),
        ].forEach((text) => {
          const cell = document.createElement('td')

          cell.textContent = text
          cell.title = text

          row.appendChild(cell)
        })

        return row
      })
    )
  },

  driver(func, args) {
    return sendMessage('popup.js', func, args)
  },

  /**
   * Log debug messages to the console
   * @param {String} message
   */
  log(message) {
    Popup.driver('log', message)
  },

  /**
   * Group technologies into categories
   * @param {Object} technologies
   */
  categorise(technologies) {
    return Object.values(
      technologies
        .filter(({ confidence }) => confidence >= 50)
        .reduce((categories, technology) => {
          technology.categories.forEach((category) => {
            categories[category.id] = categories[category.id] || {
              ...category,
              technologies: [],
            }

            categories[category.id].technologies.push(technology)
          })

          return categories
        }, {})
    )
  },

  /**
   * Callback for getDetection listener
   * @param {Array} detections
   */
  async onGetDetections(detections = []) {
    Popup.cache.detections = detections

    const el = {
      empty: document.querySelector('.empty'),
      playGame: document.querySelector('.empty__play-game'),
      game: document.querySelector('.ttt-game'),
      detections: document.querySelector('.detections'),
      issue: document.querySelector('.issue'),
      plusDownload: document.querySelector('.plus-download'),
    }

    detections = (detections || [])
      .filter(({ confidence }) => confidence >= 50)
      .filter(({ slug }) => slug !== 'cart-functionality')

    if (!detections || !detections.length) {
      el.empty.classList.remove('empty--hidden')
      el.playGame.classList.remove('empty__play-game--hidden')
      el.game.classList.add('ttt-game--hidden')
      el.detections.classList.add('detections--hidden')
      el.issue.classList.add('issue--hidden')
      el.plusDownload.classList.add('plus-download--hidden')

      return
    }

    el.empty.classList.add('empty--hidden')
    el.detections.classList.remove('detections--hidden')
    el.issue.classList.remove('issue--hidden')
    el.plusDownload.classList.remove('plus-download--hidden')

    while (el.detections.firstChild) {
      el.detections.removeChild(detections.firstChild)
    }

    const pinnedCategory = await getOption('pinnedCategory')

    const categorised = Popup.categorise(detections)

    categorised.forEach(({ id, name, technologies }) => {
      const categoryNode = Popup.templates.category.cloneNode(true)

      const el = {
        detections: document.querySelector('.detections'),
        link: categoryNode.querySelector('.category__link'),
        pins: categoryNode.querySelectorAll('.category__pin'),
        pinsActive: document.querySelectorAll('.category__pin--active'),
      }

      el.link.dataset.i18n = `categoryName${id}`

      if (pinnedCategory === id) {
        el.pins.forEach((pin) => pin.classList.add('category__pin--active'))
      }

      el.pins.forEach((pin) =>
        pin.addEventListener('click', async () => {
          const pinnedCategory = await getOption('pinnedCategory')

          el.pinsActive.forEach((pin) =>
            pin.classList.remove('category__pin--active')
          )

          if (pinnedCategory === id) {
            await setOption('pinnedCategory', null)
          } else {
            await setOption('pinnedCategory', id)

            el.pins.forEach((pin) => pin.classList.add('category__pin--active'))
          }
        })
      )

      technologies.forEach(({ name, confidence, version, icon, website }) => {
        const technologyNode = Popup.templates.technology.cloneNode(true)

        const el = {
          technologies: categoryNode.querySelector('.technologies'),
          iconImage: technologyNode.querySelector('.technology__icon img'),
          link: technologyNode.querySelector('.technology__link'),
          name: technologyNode.querySelector('.technology__name'),
          version: technologyNode.querySelector('.technology__version'),
          confidence: technologyNode.querySelector('.technology__confidence'),
        }

        el.iconImage.src = `../images/icons/${icon}`

        el.link.href = website || '#'
        el.name.textContent = name

        if (confidence < 100) {
          el.confidence.textContent = `${confidence}% sure`
        } else {
          el.confidence.remove()
        }

        if (version) {
          el.version.textContent = version
        } else {
          el.version.remove()
        }

        el.technologies.appendChild(technologyNode)
      })

      el.detections.appendChild(categoryNode)
    })

    if (categorised.length === 1) {
      el.detections.appendChild(Popup.templates.category.cloneNode(true))
    }

    Array.from(document.querySelectorAll('a')).forEach((a) =>
      a.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopImmediatePropagation()

        if (/^https?:/.test(a.href)) {
          open(a.href)
        }

        return false
      })
    )

    i18n()
  },

  async downloadCsv(event) {
    event.preventDefault()

    const { csv, filename } = getCsv()

    const file = URL.createObjectURL(
      new Blob([csv.join('\n')], { type: 'text/csv;charset=utf-8' })
    )

    const granted = await promisify(chrome.permissions, 'request', {
      permissions: ['downloads'],
    })

    if (granted) {
      chrome.downloads.download({
        url: file,
        filename,
      })
    }

    return false
  },
}

if (/complete|interactive|loaded/.test(document.readyState)) {
  Popup.init()
} else {
  document.addEventListener('DOMContentLoaded', Popup.init)
}
