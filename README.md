# Select Similar

A Thunderbird MailExtension. Select one email, press **Alt+Shift+S**, choose your matching criteria, and every email in the current folder that matches is added to your selection.

---

## Installation

### Option 1 — Install the .xpi (recommended for regular use)

Thunderbird requires extensions to be signed by Mozilla before they can be installed from a file. Until this extension is listed on [addons.thunderbird.net](https://addons.thunderbird.net), you can install the unsigned `.xpi` by temporarily allowing unsigned extensions:

1. Open **Edit → Preferences** (or **Thunderbird → Preferences** on macOS), then search for "Config Editor" at the bottom of the page, or navigate directly to `about:config` via **Tools → Developer Tools → Error Console** and typing `about:config` there — or open a compose window, click Help, About, triple-click the version string, then type `about:config`. *(Thunderbird's config editor is not exposed as a normal preference page — the easiest path is described below.)*

   **Simplest path to about:config:**
   - Press **Alt** to show the menu bar (if hidden)
   - **Tools → Developer Tools → Error Console**
   - In the console input box, type: `about:config` and press Enter — this opens the config editor in a tab

2. Search for `xpinstall.signatures.required` and double-click it to set it to `false`.

3. Download `select-similar-1.0.0.xpi` from the [latest release](../../releases/latest).

4. In Thunderbird, go to **Tools → Add-ons and Themes**.

5. Click the gear icon (⚙) → **Install Add-on From File…** and select the downloaded `.xpi`.

6. Click **Add** when prompted.

> **Note:** Setting `xpinstall.signatures.required` to `false` allows any unsigned extension to be installed. You may wish to re-enable it after installing this extension, though doing so will prevent the extension loading on next restart unless it has been signed.

---

### Option 2 — Developer / debug mode (no signature required)

This loads the extension temporarily — it will be removed when Thunderbird restarts.

1. Press **Alt** to show the menu bar (if hidden).
2. Go to **Tools → Developer Tools → Debug Add-ons**.
3. Click **Load Temporary Add-on…**
4. Navigate to the `Similar Email Selector` folder and select `manifest.json`.
5. The extension is active until Thunderbird restarts.

---

## Keyboard shortcut

**Alt+Shift+S** — fires when exactly one message is selected in the current folder.

### Remapping the shortcut

1. Go to **Tools → Add-ons and Themes**.
2. Click the gear icon (⚙) → **Manage Extension Shortcuts**.
3. Find "Select Similar" and assign a new key combination.

---

## Usage

1. Open a regular mail folder (not Unified Inbox, a tag folder, or a saved search).
2. Select **exactly one** email.
3. Press **Alt+Shift+S**.
4. A modal opens showing attributes of that email. Tick the criteria you want to match on.
5. Click **Select Similar** — all matching emails in the folder are added to your selection.
6. Click **Cancel** to close without changing the selection.

---

## Matching options

| Option | What it matches |
|---|---|
| **Subject (contains)** | Messages whose subject contains the reference string (case-insensitive substring). Pre-populated with the seed's subject with Re:/Fwd: prefixes stripped; you can edit it freely. |
| **Ignore Re: / Fwd: prefixes** | When checked, strips Re:, Fwd:, and Fw: prefixes from *candidate* subjects before comparing. Your reference string is used as typed. |
| **Sender (full address)** | Exact match on the sender's full email address (case-insensitive). |
| **Sender domain only** | Matches any sender from the same domain (e.g. `example.com`). |
| **Recipient (To / CC)** | Matches messages that share at least one To or CC address with the seed email. |
| **Has attachment** | Matches messages with the same attachment status as the seed: if the seed has attachments, finds others with attachments; if not, finds others with none. |

Multiple options use **AND** logic — a candidate must satisfy all checked criteria.

**Sender (full address)** and **Sender domain only** are mutually exclusive.

When you tick a criterion, its value field becomes editable so you can refine the search term before confirming.

---

## Notes

- **Persistence:** Your checkbox states are saved and restored between sessions. Field values are always re-extracted fresh from the selected email.
- **Performance:** The "Has attachment" option checks each message in the folder individually. On large folders this can take a few seconds — a spinner is shown while it runs.
- **Virtual folders:** Unified Inbox, tag folders, and saved search folders are not supported. The modal will show an error message if you trigger it from one of those.
- **No match:** If nothing matches, the original selection is unchanged.

---

## Assumptions

- Recipient matching is an overlap check: a candidate matches if *any* of its To/CC addresses appears in the seed's To/CC list.
- "Has attachment" matches none-to-none as well as some-to-some.
- The seed message is always included in the result, since it matches its own criteria.

---

## Building from source

No build step required — the extension is plain JavaScript.

To package a `.xpi`:

```
cd "Similar Email Selector"
zip -r select-similar.xpi manifest.json background.js modal/
```

Or on Windows (PowerShell):

```powershell
Compress-Archive -Path manifest.json, background.js, modal -DestinationPath select-similar.xpi
```

---

## Licence

MIT
