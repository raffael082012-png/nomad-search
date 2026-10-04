# Nomad

Nomad is a minimal search proxy. It retrieves live results from Bing, with DuckDuckGo as a fallback, displays titles, destination URLs, and snippets, and opens result pages through its in-app page relay. Wiki-hosted results are excluded.

## Run it

Requires Node.js 20 or newer. From this folder, run:

```sh
npm start
```

Then open <http://localhost:3000>. Set `PORT` to use a different port.

## Deploy for visitors

Nomad is deployed at <https://nomad-en95.onrender.com>. The connected private GitHub repository is `raffael082012-png/nomad-search`; commits to `main` deploy automatically.

For a fresh Render deployment, the included `render.yaml` configures a public web service. To publish it:

1. Create a repository on GitHub named `nomad`.
2. Upload the *contents* of this folder to the repository root. `render.yaml`, `Dockerfile`, `server.mjs`, `index.html`, and `package.json` should all be at the top level.
3. In Render, choose **New + → Blueprint** and connect that GitHub repository.
4. Review the service named `nomad` and choose **Apply**.
5. When deployment finishes, open the `onrender.com` URL shown on the service page and share it. Visitors only need that URL.

Render documents that web services receive a public `onrender.com` URL and that a Blueprint can create services from `render.yaml` ([web services](https://render.com/docs/web-services), [Blueprints](https://render.com/docs/blueprint-spec)). The host must allow outbound HTTPS requests to DuckDuckGo. For a custom domain, add it in the Render service settings.

## Notes

Search requests pass through to Bing and, if needed, DuckDuckGo, so availability, result coverage, and upstream policies depend on those providers. The page relay supports public HTTP(S) pages and does not forward visitor cookies or sign-in credentials. Some sign-in flows and complex web apps may not work in the isolated viewer. Nomad does not store searches. A public deployment also means the hosting provider receives traffic metadata; review its terms and configure rate limits if needed. Render's free web services spin down after inactivity; use a paid plan for always-on availability.
