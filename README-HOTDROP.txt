Odysseus Mail Pro remote image proxy hot-drop

Copy the contents of this folder into the root of your Odysseus repo.

Replaces:
- routes/email_routes.py
- static/js/emailPro/index.js
- static/js/emailLibrary.js
- static/style.css

This build is cumulative on top of the working Mail Pro build with:
- accounts/folders/unified inbox
- tags
- date/unread-dot fix
- HTML reader improvements
- cid inline-image resolver
- focus reader back button

New in this build:
1. Remote image proxy
   Adds:
   GET /api/email/pro/image-proxy?url=...
   Mail Pro rewrites normal http/https email images through this route.

   This helps with:
   - CSP/referrer restrictions
   - third-party hotlinked images that fail inside the app shell
   - protocol-relative // image URLs
   - srcset images
   - lazy attributes like data-src, data-original, data-delayed-url

2. Security guardrails
   The proxy only accepts http/https URLs and blocks localhost/private/link-local/reserved IPs to reduce SSRF risk.
   It only returns image/* or generic binary image responses and limits downloads to 8 MB.

Important:
- Restart the Python app/server after copying because routes/email_routes.py changed.
- Hard-refresh the UI after restart.
- If some images still fail, inspect browser DevTools Network for /api/email/pro/image-proxy response codes.
