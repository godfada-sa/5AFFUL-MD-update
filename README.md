# Safful-Md

Safful-Md is a WhatsApp multi-device bot powered by Baileys.

**Supported hosts:** Ubuntu VPS (AWS EC2 free tier, etc.), Node.js panels (Pterodactyl), Heroku-style platforms.

## Requirements

- Node.js **22.12 or newer** (the bundled Baileys rc14 is ESM-only — Node 21 and older crash with `ERR_REQUIRE_ESM`)
- FFmpeg (media commands)
- A WhatsApp account to link

---

## Ubuntu VPS deployment (fresh install)

Run everything as the regular `ubuntu` user (sudo is fine; root login is not needed).

### 1. Update the system

```bash
sudo apt update && sudo apt upgrade -y
```

### 2. Install system dependencies

```bash
sudo apt install -y git curl unzip nano build-essential python3 ffmpeg
```

Why each one:

| Package | Needed for |
| --- | --- |
| `git` | cloning / pulling the repo |
| `curl` | the Node.js installer |
| `unzip` | **required** — without it `npm install` fails with "no zip archiver is available" (puppeteer) |
| `nano` | editing `.env` |
| `build-essential` + `python3` | compiling native modules (`sharp`, `canvas`) via node-gyp |
| `ffmpeg` | audio / video / sticker commands |

### 3. Install Node.js 22

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
```

**`node -v` must print `v22.12.0` or higher.** If it shows anything lower, stop — the bot will crash with `ERR_REQUIRE_ESM`.

### 4. Get the code

```bash
cd ~
git clone https://github.com/godfada-sa/5AFFUL-BOT.git safful-md
cd safful-md
```

### 5. Install dependencies

```bash
export PUPPETEER_SKIP_DOWNLOAD=true
npm install --no-audit
```

Notes on the output:

- The `37 vulnerabilities` and `npm warn install-scripts ... blocked` lines are **normal** — ignore them.
- `Sharp native binary is unavailable` at runtime is also harmless (continues without legacy image resizing).
- `unzip` (step 2) + `PUPPETEER_SKIP_DOWNLOAD=true` prevent the puppeteer chrome-download crash.

### 6. Create the `.env`

```bash
nano .env
```

```bash
OWNER_NUMBER=233XXXXXXXXX
SUDO=233XXXXXXXXX
OWNER_NAME=Safful
BOT_NAME=Safful-Md
PREFIX=.
MODE=private
PORT=8002
TZ=Africa/Accra
SAFFUL_SELF_HOSTED=true
SAFFUL_PRESERVE_DM_NOTIFICATIONS=true
READ_MESSAGE=false
READ_COMMAND=false
WAPRESENCE=unavailable
AUTH_METHOD=pairing
PAIRING_NUMBER=233XXXXXXXXX
```

Save with `Ctrl+O`, Enter, then `Ctrl+X`.

Rules that matter:

- `PAIRING_NUMBER` must be your exact number with country code — no `+`, no leading `0`, **no extra digits**. A wrong number always gets refused on the phone.
- `SUDO` is the number that receives deleted-message forwards and the "Safful-Md Connected" banner (can be the same as `OWNER_NUMBER`).
- `SAFFUL_PRESERVE_DM_NOTIFICATIONS=true` keeps your phone's personal-chat notifications working while the bot is connected.

### 7. Install PM2 and start

```bash
sudo npm install -g pm2
pm2 start index.js --name safful-md
pm2 save
```

**Verify exactly ONE instance is running** — two instances fight over the session and the phone rejects pairing:

```bash
pm2 list
# should show ONE safful-md row
ps aux | grep "[n]ode index.js" | wc -l
# should print 1
```

Make the bot survive server reboots:

```bash
pm2 startup systemd
```

PM2 prints one `sudo env PATH=... pm2 startup systemd -u ubuntu --hp /home/ubuntu` command — copy, run exactly that, then:

```bash
pm2 save
```

### 8. Link WhatsApp

```bash
pm2 logs safful-md --lines 40
```

- Session kept or auto-recovered: `[boot] auth-prep: session=existing` → `✅ Whatsapp Login Successful!` → `Safful-Md Connected`. **No pairing needed.**
- Fresh install: a big banner prints your 8-character code. On the phone: **WhatsApp → Linked devices → Link a device → Link with phone number instead** → type the code exactly.

### 9. Daily operations

```bash
pm2 logs safful-md                  # view logs
pm2 restart safful-md               # restart
pm2 stop safful-md                  # stop
git pull && pm2 restart safful-md   # update the bot
pm2 delete safful-md                # remove the process entirely
```

---

## The three hard rules

1. **Never start the bot twice.** One `pm2 start`, one process. If `pm2 list` ever shows two rows, run `pm2 delete safful-md`, then `pkill -f "node index.js"`, and start once.
2. **Run the bot on ONE host.** Never run the Pterodactyl panel and a VPS simultaneously — two instances kick each other off WhatsApp.
3. **Never delete `lib/Suhail_Baileys`** unless you deliberately want to re-pair. Sessions survive all restarts automatically. For a truly fresh login, delete both `lib/Suhail_Baileys` **and** `lib/auth-backups`.

---

## Optional: QR page in a browser

Open `http://<your-server-ip>:<PORT>/qr`. Requires an inbound firewall/security-group rule for the `PORT` (default `8002`) from your IP.

## Security

- `.env`, sessions, QR images, logs, chat state, and live protection settings are excluded from Git.
- Keep this repository private.
- Use a different `OWNER_NUMBER` / `SUDO` for each deployment.
- The bot's local HTTP server is for diagnostics; do not expose it to the internet unless you open `PORT` deliberately.
