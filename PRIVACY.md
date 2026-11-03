# Prismappalyzer privacy policy

_Last updated: 3 November 2026_

Prismappalyzer is a browser extension that identifies the technologies (CMS, frameworks, analytics tools, web servers, CDNs and more) used by websites. It works in two ways:

- **Technology profiling (default):** shows the technologies of the website you are viewing.
- **Automation (optional, off by default):** scans websites assigned by a technology discovery service that you configure, or a list of websites you enter, and reports their technologies to that service. A separate opt-in setting also reports the technologies of websites you browse to that service, and a **Report** button sends the current website's technologies when you click it.

## What the extension reads

To detect technologies, the extension reads the following from the pages it analyses:

- page HTML, script URLs, meta tags and selected JavaScript variables
- HTTP response headers
- cookies set by the site

## Technology profiling

For the websites you browse, all detection happens locally in your browser. Unless you turn on browsing reports (see below), the extension:

- does **not** send your browsing history, page content, headers or cookies to the developer or to any third party
- does **not** use analytics, tracking or advertising
- does **not** sell or transfer user data

## Automation

Nothing is sent until you enter a service URL, an API key and a zone in the popup's Settings tab. Automation then runs only while you have switched it on with **Start** in the Automation tab, and stops when you click **Stop**. In the Automation tab you choose which websites it scans:

- **Tasks from the discovery service:** every 30 seconds the extension requests a website address from the service you configured, opens it in a background tab, detects its technologies, closes the tab and sends the detected technologies for that address (name, version, category and the pattern that matched) to the same service.
- **A list of URLs:** the extension opens each website you entered, one by one, in a background tab, waits 20 seconds after the page loads, closes the tab and sends the website's origin and detected technologies, in the same form as browsing reports (below), to the service. Automation switches itself off at the end of the list.

### Browsing reports (separate opt-in)

If you also tick **Also send the technologies of websites I browse**, then for each website you visit the extension sends, to the same service:

- the website's address, reduced to its origin (scheme, host and port, for example `https://www.example.com`; no path or query string)
- the technologies detected on it (name, version, category, the pattern that matched and the short text it matched, such as `nginx/1.24.0`)

Each website is sent at most once a day, and only while automation is on. Incognito tabs, domains you disabled in the popup and the automation's own background tabs are never reported. Untick the setting, or stop automation, to stop.

### Report button

Once the Settings tab is filled in, the Technologies tab shows a **Report** button. Clicking it sends the current website's origin and detected technologies, in the same form as browsing reports, to the service. Nothing is sent unless you click it.

### In all cases

Apart from the short text that matched a technology pattern, the extension never sends page content, cookies, form data or any personal information. Data goes only to the service URL you entered; the developer does not receive it. The service URL, API key, zone, the URL list and its progress, the list of websites reported in the last day and the last 20 websites scanned are stored locally in the extension's storage.

## Local storage

Detection results and your settings are stored locally using the browser's extension storage, so results appear quickly when you return to a site. You can clear the detection cache at any time from the extension's options page, and everything is removed when you uninstall the extension.

## Downloads

If you click **Export**, the extension asks for permission to save the detected technologies as a CSV file on your computer. The file is not sent anywhere.

## Contact

Questions about this policy: open an issue at https://github.com/kerimkaraca/prismappalyzer/issues
