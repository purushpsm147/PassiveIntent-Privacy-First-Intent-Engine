# PassiveIntent Landing

Static landing page for `passiveintent.dev`.

## Local preview

From repo root:

```bash
npx serve landing
```

Then open `http://localhost:3000`.

## Deploy on Cloudflare Pages (recommended free path)

1. Push this repo to GitHub.
2. In Cloudflare dashboard: `Workers & Pages` -> `Create` -> `Pages` -> `Connect to Git`.
3. Select this repository.
4. Build settings:
   - Framework preset: `None`
   - Build command: _(leave empty)_
   - Build output directory: `landing`
5. Deploy.
6. Add custom domain:
   - `Workers & Pages` -> your project -> `Custom domains` -> `Set up a custom domain`.
   - Add `passiveintent.dev` and `www.passiveintent.dev`.
7. In Cloudflare DNS, ensure proxied DNS records are created automatically (orange cloud enabled).

Because your nameservers are already on Cloudflare, no Hostinger DNS changes should be needed after this.

## Deploy on Vercel (alternative)

1. Import GitHub repo in Vercel.
2. Framework preset: `Other`.
3. Build command: _(empty)_.
4. Output directory: `landing`.
5. Add custom domain `passiveintent.dev` in project settings.

## Files

- `index.html` - structure/content
- `styles.css` - visual design/responsive layout
- `script.js` - reveal animation and dynamic year
- `_headers` - security headers for static hosting

## Social preview image

The landing page metadata expects a social sharing image at:

- `landing/social-preview.png`

Recommended asset spec:

- `1200x630` pixels
- `PNG` format
- Keep important text away from the outer edges for cropped previews

This file is used by Open Graph and Twitter metadata in `index.html`, which powers previews on X/Twitter, LinkedIn, WhatsApp, Slack, Discord, and other social/link unfurlers.
