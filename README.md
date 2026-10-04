# Nomad

Nomad is a search engine with an in-page web proxy. It retrieves live results from Bing, with DuckDuckGo as a fallback, displays titles, destination URLs, and snippets, and opens sites in a full-window Scramjet viewer. Wiki-hosted results are excluded.

## Run it

Requires Node.js 20 or newer. From this folder, run:

```sh
npm start
```

Then open <http://localhost:3000>. Set `PORT` to use a different port.

## Deploy for visitors

Nomad is deployed at <https://nomad-en95.onrender.com>. Its source is published at <https://github.com/raffael082012-png/nomad-search>; commits to `main` deploy automatically.

For a fresh Render deployment, the included `render.yaml` configures a public web service. To publish it:

1. Create a repository on GitHub named `nomad`.
2. Upload the *contents* of this folder to the repository root. `render.yaml`, `Dockerfile`, `server.mjs`, `index.html`, and `package.json` should all be at the top level.
3. In Render, choose **New + → Blueprint** and connect that GitHub repository.
4. Review the service named `nomad` and choose **Apply**.
5. When deployment finishes, open the `onrender.com` URL shown on the service page and share it. Visitors only need that URL.

Render documents that web services receive a public `onrender.com` URL and that a Blueprint can create services from `render.yaml` ([web services](https://render.com/docs/web-services), [Blueprints](https://render.com/docs/blueprint-spec)). The host must allow outbound HTTPS requests to DuckDuckGo. For a custom domain, add it in the Render service settings.

## Notes

Search requests pass through to Bing and, if needed, DuckDuckGo, so coverage and availability depend on those providers. Search results exclude common wiki networks. Sites open inside Nomad through Scramjet; third-party sites can still block service, require their own sign-in, or limit access from Render's datacenter IPs. This project uses Scramjet under the GNU Affero General Public License; see the upstream [Scramjet source and license](https://github.com/MercuryWorkshop/scramjet). Nomad does not store searches. Render's free web services can spin down after inactivity.
