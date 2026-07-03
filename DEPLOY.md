# Deploy Attribution Bridge to Anthony's own cloud

The goal: Anthony clicks a link, signs into Render, and the app provisions onto
**his** account with a permanent HTTPS URL — no dependence on anyone's laptop.

There are two ways to get there. Pick one.

---

## Path A — one-click deploy link (needs a GitHub repo)

**Step 1 (you, once — ~30 seconds).** From this folder, publish the repo:

```
gh repo create attribution-bridge --public --source . --push
```

(Use `--private` instead if you prefer; Anthony then has to be a collaborator
and connect his own GitHub to Render.)

**Step 2.** The deploy link becomes:

```
https://render.com/deploy?repo=https://github.com/Hari487-coder/attribution-bridge
```

Send that link to Anthony. He clicks it, signs into Render, approves the
blueprint (`render.yaml` is already in the repo — it sets the persistent disk
and start command for him), and in ~2 minutes he has his own live URL.

---

## Path B — no GitHub, manual upload (~10 min on Anthony's side)

Send Anthony the `attribution-bridge-v1.zip` and these steps:

1. Create a free account at **render.com**.
2. New → **Web Service** → **Deploy without a Git repository** (upload the zip),
   or push the unzipped folder to his own GitHub first.
3. Render auto-detects `render.yaml`. Confirm: build `npm install`, start
   `node server.js`, plan **Starter** (needed for the persistent disk).
4. Deploy. He gets `https://<his-app>.onrender.com`.

---

## After it's live (either path)

1. Open the URL → **Setup** tab.
2. Set a **dashboard password** and a **webhook key** FIRST (the app refuses to
   store API tokens until a password exists).
3. Add the master account + brokers, then follow the setup guide from Step 3
   (channel test) onward.

### Optional environment variable

`PLATFORM_DNC` — comma-separated numbers the platform must never dial. Leave
unset for normal use; the pre-check simply notes that gate step isn't simulated.

Data (config + opt-out registry) persists on the mounted disk at `/var/data`.
