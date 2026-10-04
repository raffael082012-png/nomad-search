# Nomad

Nomad is a minimal search proxy. It retrieves live results from DuckDuckGo's HTML search page and displays titles, destination URLs, and snippets. It adds no topic or category filters.

## Run it

Requires Node.js 20 or newer. From this folder, run:

```sh
npm start
```

Then open <http://localhost:3000>. Set `PORT` to use a different port.

## Deploy for visitors

The included `render.yaml` configures a public Render web service. To publish it:

1. Create a repository on GitHub named `nomad`.
2. Upload the *contents* of this folder to the repository root. `render.yaml`, `Dockerfile`, `server.mjs`, `index.html`, and `package.json` should all be at the top level.
3. In Render, choose **New + → Blueprint** and connect that GitHub repository.
4. Review the service named `nomad` and choose **Apply**.
5. When deployment finishes, open the `onrender.com` URL shown on the service page and share it. Visitors only need that URL.

Render documents that web services receive a public `onrender.com` URL and that a Blueprint can create services from `render.yaml` ([web services](https://render.com/docs/web-services), [Blueprints](https://render.com/docs/blueprint-spec)). The host must allow outbound HTTPS requests to DuckDuckGo. For a custom domain, add it in the Render service settings.

## Notes

Search requests pass through to DuckDuckGo, so availability, result coverage, and upstream policies depend on that provider. This app does not bypass provider access controls and does not store searches. A public deployment also means the hosting provider receives traffic metadata; review its terms and configure rate limits if needed.
