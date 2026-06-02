# Select Similar — Implementation Plan

## Prerequisites

- Read `SPEC.md` in full before starting.
- All decisions about behaviour, edge cases, and assumptions are documented there.
- This document covers: confirmed API facts, file-by-file implementation detail, data flow, and code patterns.

---

## Confirmed API facts

All facts below were verified against https://webextension-api.thunderbird.net before this plan was written. Do not guess API signatures — use only what is listed here.

### Manifest

```json
{
  "manifest_version": 3,
  "background": {
    "scripts": ["background.js"]
  }
}
```

Thunderbird MV3 uses `background.scripts` (an array of script paths), NOT `service_worker`. This is specific to Thunderbird's Firefox-derived architecture.

### Namespace

`messenger.*` and `browser.*` are identical. Use `messenger.*` throughout for clarity.

### `messenger.messages.list(folderId)`

- **Parameter:** `folderId` — a `MailFolderId` string (session-scoped, not persistent)
- **Returns:** `Promise<MessageList>`
- **Permissions:** `accountsRead`, `messagesRead`

`MessageList` shape:
```
{
  id: string | null,   // null = no more pages; non-null = call continueList
  messages: MessageHeader[]
}
```

### `messenger.messages.continueList(messageListId)`

- **Parameter:** `messageListId` — the `MessageList.id` value from a previous call
- **Returns:** `Promise<MessageList>`
- **Permissions:** `messagesRead`

Pagination loop pattern:
```javascript
let page = await messenger.messages.list(folderId);
const all = [...page.messages];
while (page.id !== null) {
  page = await messenger.messages.continueList(page.id);
  all.push(...page.messages);
}
```

### `messenger.mailTabs.getSelectedMessages([tabId])`

- **Parameter:** `tabId` (optional integer) — pass explicitly from the `onCommand` tab
- **Returns:** `Promise<MessageList>` — paginate in the same way as above
- **Permissions:** `messagesRead`

### `messenger.mailTabs.setSelectedMessages([tabId], messageIds)`

- **Parameters:** `tabId` (optional integer), `messageIds` — array of `MessageId` (integers)
- **Returns:** `Promise<void>`
- **Behaviour:** **Replaces** the entire selection. Does not add to it.
- **Permissions:** `messagesRead`, `accountsRead`

This means: fetch current selection → merge with matched IDs → call setSelectedMessages with merged array. See "Adding to the selection" in SPEC.md.

### `messenger.mailTabs.query([queryInfo])`

- **Parameter:** `{ active?: boolean, currentWindow?: boolean }`
- **Returns:** `Promise<MailTab[]>`
- **No special permissions** for the query itself; `accountsRead` is required to read `displayedFolder` on the returned `MailTab`

`MailTab` relevant properties:
```
{
  tabId: integer,
  windowId: integer,
  active: boolean,
  displayedFolder: MailFolder  // requires accountsRead; may be absent
}
```

`MailFolder` relevant properties:
```
{
  id: MailFolderId (string),
  name: string,
  path: string,
  accountId: MailAccountId,  // absent for unified/tag folders
  isVirtual: boolean,
  isTag: boolean,
  isUnified: boolean,
  specialUse: MailFolderSpecialUse[]
}
```

### `messenger.windows.create([createData])`

- **Parameters used:** `{ url: string, type: "popup", width: integer, height: integer }`
- **Returns:** `Promise<Window>`
- No special permissions required

The `url` must be an extension-internal URL. Use `messenger.runtime.getURL("modal/modal.html")`.

### `messenger.messages.listAttachments(messageId)`

- **Parameter:** `messageId` — a `MessageId` (integer)
- **Returns:** `Promise<MessageAttachment[]>` — empty array if no attachments
- **Permissions:** `messagesRead`
- **Note:** There is NO `hasAttachment` flag on `MessageHeader`. This call is the only way to check.

### `messenger.storage.local`

Standard WebExtension storage. Persists across Thunderbird restarts.

- `get(key)` → `Promise<object>`
- `set(items)` → `Promise<void>`
- `remove(key)` → `Promise<void>`
- **Permission:** `"storage"`

### `messenger.commands.onCommand`

```javascript
messenger.commands.onCommand.addListener(async (command, tab) => {
  // command: string — the command name from manifest.json
  // tab: tabs.Tab — the active tab; use tab.id as needed
});
```

`tab` here is a `tabs.Tab`, not a `MailTab`. To get the `MailTab` (with `displayedFolder`), call `messenger.mailTabs.query({ active: true, currentWindow: true })`.

### `MessageHeader` properties

```
id: MessageId (integer)
author: string (MailBoxHeaderString, e.g. "Name <user@domain.com>")
subject: string
date: Date
recipients: string[]   (To addresses, MailBoxHeaderString[])
ccList: string[]       (CC addresses, MailBoxHeaderString[])
bccList: string[]
flagged: boolean
read: boolean
folder: MailFolder     (requires accountsRead)
```

`MailBoxHeaderString` format: `"Display Name <user@domain.com>"` or `"<user@domain.com>"` or `"user@domain.com"`. Parse with:

```javascript
function parseEmailAddress(mailboxString) {
  const angleMatch = mailboxString.match(/<([^<>\s]+@[^<>\s>]+)>/);
  const email = angleMatch ? angleMatch[1].trim() : mailboxString.trim();
  const atIndex = email.lastIndexOf("@");
  const domain = atIndex !== -1 ? email.slice(atIndex + 1) : "";
  return { email, domain };
}
```

---

## File structure

```
Similar Email Selector/
├── manifest.json        Extension manifest
├── background.js        Command listener; builds context; opens modal
├── modal/
│   ├── modal.html       Modal popup UI
│   ├── modal.css        Modal styles
│   └── modal.js        Modal logic: form population, matching, selection update
├── SPEC.md              Behavioural specification (this project)
├── PLAN.md              This file
└── README.md            User-facing: install steps, usage, option descriptions
```

---

## Data flow

```
Alt+Shift+S
    │
    ▼
background.js — onCommand handler
    1. messenger.mailTabs.query({ active: true, currentWindow: true })
       → MailTab (with displayedFolder)
    2. Guard: if !mailTab || !mailTab.displayedFolder → return
    3. Check virtual folder: if isVirtual || isTag || isUnified
       → write error context (folderIsVirtual: true) to storage.local
       → windows.create() → modal shows error state
       → return
    4. messenger.mailTabs.getSelectedMessages(mailTab.tabId)
       → paginate → collect all selected MessageHeaders
    5. Guard: if selectedMessages.length !== 1 → return
    6. const msg = selectedMessages[0]
    7. messenger.messages.listAttachments(msg.id)
       → hasAttachment = attachments.length > 0
    8. Build context object (see shape below)
    9. messenger.storage.local.set({ "selectSimilar.pendingContext": context })
   10. messenger.windows.create({
           url: messenger.runtime.getURL("modal/modal.html"),
           type: "popup",
           width: 520,
           height: 420
       })

Context object shape:
{
  folderId: string,         // MailFolder.id — used for messages.list()
  folderIsVirtual: false,
  messageId: number,        // MessageHeader.id
  subject: string,          // MessageHeader.subject (raw, unstripped)
  author: string,           // MessageHeader.author (raw MailBoxHeaderString)
  recipients: string[],     // MessageHeader.recipients (MailBoxHeaderString[])
  ccList: string[],         // MessageHeader.ccList (MailBoxHeaderString[])
  hasAttachment: boolean
}

    │
    ▼
modal/modal.js — DOMContentLoaded
    1. messenger.storage.local.get("selectSimilar.pendingContext") → context
    2. messenger.storage.local.remove("selectSimilar.pendingContext")  // clean up
    3. messenger.storage.local.get("selectSimilar.checkboxStates") → savedStates
    4. If context.folderIsVirtual:
       → show #error-message div, hide #criteria-form
       → return
    5. Parse context.author → { email: senderEmail, domain: senderDomain }
    6. Parse context.recipients + context.ccList → array of email strings
    7. Compute strippedSubject = stripAllPrefixes(context.subject)
    8. Populate fields:
       - subjectInput.value = strippedSubject
       - senderFullDisplay.value = senderEmail
       - senderDomainDisplay.value = senderDomain
       - recipientDisplay.value = recipientEmails.join(", ")
       - attachmentDisplay.value = context.hasAttachment ? "Yes" : "No"
    9. Apply savedStates (or defaults if no saved state exists)
   10. Attach change listeners: mutual exclusivity, updateConfirmState, saveCheckboxStates

    │
    User clicks "Select Similar"
    │
    ▼
modal/modal.js — confirmBtn click handler
    1. saveCheckboxStates()
    2. Show loading spinner; disable confirm button
    3. Collect criteria from UI:
       {
         subject: { enabled, value: subjectInput.value.trim() },
         ignorePrefix: ignorePrefixChk.checked,
         senderFull: { enabled, value: senderEmail },
         senderDomain: { enabled, value: senderDomain },
         recipient: { enabled, values: recipientEmails },
         hasAttachment: { enabled, value: context.hasAttachment }
       }
    4. Enumerate ALL folder messages:
       page = await messenger.messages.list(context.folderId)
       collect; loop continueList while page.id !== null
    5. For each candidate MessageHeader:
       evaluate all enabled criteria (AND logic)
       if hasAttachment criterion enabled:
           call messenger.messages.listAttachments(candidate.id) per candidate
       collect matching candidate IDs
    6. messenger.mailTabs.query({ active: true, currentWindow: true }) → mailTab
    7. messenger.mailTabs.getSelectedMessages(mailTab.tabId)
       → paginate → collect currentSelectedIds
    8. mergedIds = [...new Set([...currentSelectedIds, ...matchedIds])]
    9. messenger.mailTabs.setSelectedMessages(mailTab.tabId, mergedIds)
   10. window.close()
```

---

## File-by-file implementation detail

---

### `manifest.json`

```json
{
  "name": "Select Similar",
  "version": "1.0.0",
  "description": "Select all emails in the current folder matching attributes of a selected email.",
  "manifest_version": 3,
  "background": {
    "scripts": ["background.js"]
  },
  "commands": {
    "open-select-similar": {
      "suggested_key": { "default": "Alt+Shift+S" },
      "description": "Open Select Similar modal"
    }
  },
  "permissions": [
    "accountsRead",
    "messagesRead",
    "storage"
  ]
}
```

Notes:
- No `action`, `page_action`, `browser_action` — extension is shortcut-driven only.
- No `web_accessible_resources` — modal is opened as a popup window with the extension URL, not embedded in any page.
- No content scripts.

---

### `background.js`

Top-level structure:

```javascript
messenger.commands.onCommand.addListener(async (command, tab) => { ... });

async function collectAllMessages(firstPage) { ... }
function parseEmailAddress(mailboxString) { ... }
```

**`collectAllMessages(firstPage)`**

Reusable helper for the pagination loop. Takes the first `MessageList` page, paginates to completion, returns a flat `MessageHeader[]`.

**`parseEmailAddress(mailboxString)`**

Extracts `{ email, domain }` from a `MailBoxHeaderString`. Used to derive sender email and domain from `msg.author`.

**`onCommand` handler — step by step:**

```javascript
if (command !== "open-select-similar") return;

const [mailTab] = await messenger.mailTabs.query({ active: true, currentWindow: true });
if (!mailTab || !mailTab.displayedFolder) return;

const folder = mailTab.displayedFolder;
const folderIsVirtual = folder.isVirtual || folder.isTag || folder.isUnified;

const firstSelectionPage = await messenger.mailTabs.getSelectedMessages(mailTab.tabId);
const selectedMessages = await collectAllMessages(firstSelectionPage);

if (!folderIsVirtual && selectedMessages.length !== 1) return;

let context;
if (folderIsVirtual) {
  context = { folderIsVirtual: true };
} else {
  const msg = selectedMessages[0];
  const attachments = await messenger.messages.listAttachments(msg.id);
  context = {
    folderId: folder.id,
    folderIsVirtual: false,
    messageId: msg.id,
    subject: msg.subject,
    author: msg.author,
    recipients: msg.recipients,
    ccList: msg.ccList,
    hasAttachment: attachments.length > 0,
  };
}

await messenger.storage.local.set({ "selectSimilar.pendingContext": context });

await messenger.windows.create({
  url: messenger.runtime.getURL("modal/modal.html"),
  type: "popup",
  width: 520,
  height: 420,
});
```

Error handling: wrap the entire handler body in try/catch; log failures with `console.error`.

---

### `modal/modal.html`

Structure:

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <link rel="stylesheet" href="modal.css">
</head>
<body>

  <!-- Error state (shown instead of form for virtual folders) -->
  <div id="error-state" hidden>
    <p id="error-message"></p>
    <button id="close-btn">Close</button>
  </div>

  <!-- Criteria form -->
  <div id="criteria-form">
    <table>
      <tbody>
        <!-- Row 1: Subject -->
        <tr>
          <td><input type="checkbox" id="chk-subject"></td>
          <td><label for="chk-subject">Subject (contains)</label></td>
          <td><input type="text" id="val-subject"></td>
        </tr>
        <!-- Row 2: Ignore prefixes (no value field) -->
        <tr>
          <td><input type="checkbox" id="chk-ignore-prefix"></td>
          <td colspan="2"><label for="chk-ignore-prefix">Ignore Re: / Fwd: prefixes</label></td>
        </tr>
        <!-- Row 3: Sender full -->
        <tr>
          <td><input type="checkbox" id="chk-sender-full"></td>
          <td><label for="chk-sender-full">Sender (full address)</label></td>
          <td><input type="text" id="val-sender-full" readonly></td>
        </tr>
        <!-- Row 4: Sender domain -->
        <tr>
          <td><input type="checkbox" id="chk-sender-domain"></td>
          <td><label for="chk-sender-domain">Sender domain only</label></td>
          <td><input type="text" id="val-sender-domain" readonly></td>
        </tr>
        <!-- Row 5: Recipient -->
        <tr>
          <td><input type="checkbox" id="chk-recipient"></td>
          <td><label for="chk-recipient">Recipient (To / CC)</label></td>
          <td><input type="text" id="val-recipient" readonly></td>
        </tr>
        <!-- Row 6: Has attachment -->
        <tr>
          <td><input type="checkbox" id="chk-attachment"></td>
          <td><label for="chk-attachment">Has attachment</label></td>
          <td><input type="text" id="val-attachment" readonly></td>
        </tr>
      </tbody>
    </table>

    <!-- Loading state -->
    <div id="loading" hidden>
      <span class="spinner"></span>
      <span>Searching...</span>
    </div>

    <div id="button-row">
      <button id="confirm-btn" disabled>Select Similar</button>
      <button id="cancel-btn">Cancel</button>
    </div>
  </div>

  <script src="modal.js"></script>
</body>
</html>
```

---

### `modal/modal.css`

Requirements:
- Fixed-width layout matching the popup window (no horizontal scroll)
- Table rows: checkbox column narrow, label column medium, value column wide
- Disabled button style clearly distinct from enabled
- Spinner animation (CSS-only, no GIF)
- Error state: centred message, single button
- No external fonts, images, or CDN resources

---

### `modal/modal.js`

Top-level structure:

```javascript
// Cached context read from storage.local on load
let ctx = null;
// Parsed sender/recipient values derived from ctx
let senderEmail = "";
let senderDomain = "";
let recipientEmails = [];

document.addEventListener("DOMContentLoaded", async () => { ... });

// Helpers
function parseEmailAddress(mailboxString) { ... }
function extractEmailList(mailboxStrings) { ... }  // maps an array of MailBoxHeaderStrings to plain email strings
function stripAllPrefixes(subject) { ... }
async function collectAllMessages(firstPage) { ... }
function updateConfirmState() { ... }
async function saveCheckboxStates() { ... }
async function applyDefaultOrSavedStates(savedStates) { ... }
async function runMatching() { ... }  // called by confirmBtn click handler
function messageMatchesCriteria(msg, candidateAttachments, criteria) { ... }
```

**`DOMContentLoaded` handler — step by step:**

```javascript
// Read context
const result = await messenger.storage.local.get("selectSimilar.pendingContext");
ctx = result["selectSimilar.pendingContext"];
await messenger.storage.local.remove("selectSimilar.pendingContext");

if (!ctx) {
  // Shouldn't happen; close gracefully
  window.close();
  return;
}

if (ctx.folderIsVirtual) {
  document.getElementById("error-message").textContent =
    "Select Similar only works in regular mail folders.";
  document.getElementById("error-state").hidden = false;
  document.getElementById("criteria-form").hidden = true;
  document.getElementById("close-btn").addEventListener("click", () => window.close());
  return;
}

// Parse derived values
({ email: senderEmail, domain: senderDomain } = parseEmailAddress(ctx.author));
recipientEmails = extractEmailList([...ctx.recipients, ...ctx.ccList]);

// Populate value fields
document.getElementById("val-subject").value = stripAllPrefixes(ctx.subject);
document.getElementById("val-sender-full").value = senderEmail;
document.getElementById("val-sender-domain").value = senderDomain;
document.getElementById("val-recipient").value = recipientEmails.join(", ");
document.getElementById("val-attachment").value = ctx.hasAttachment ? "Yes" : "No";

// Restore saved checkbox states (or apply defaults)
const stateResult = await messenger.storage.local.get("selectSimilar.checkboxStates");
await applyDefaultOrSavedStates(stateResult["selectSimilar.checkboxStates"] ?? null);

// Wire up listeners
const chkSubject = document.getElementById("chk-subject");
const chkSenderFull = document.getElementById("chk-sender-full");
const chkSenderDomain = document.getElementById("chk-sender-domain");

chkSenderFull.addEventListener("change", () => {
  // Mutual exclusivity: checking full address unchecks domain and vice versa
  if (chkSenderFull.checked) chkSenderDomain.checked = false;
  updateConfirmState();
  saveCheckboxStates();
});
chkSenderDomain.addEventListener("change", () => {
  if (chkSenderDomain.checked) chkSenderFull.checked = false;
  updateConfirmState();
  saveCheckboxStates();
});

// All other checkboxes: just update state and save
["chk-subject", "chk-ignore-prefix", "chk-recipient", "chk-attachment"].forEach(id => {
  document.getElementById(id).addEventListener("change", () => {
    updateConfirmState();
    saveCheckboxStates();
  });
});

// Subject input: re-evaluate confirm state on every keystroke
document.getElementById("val-subject").addEventListener("input", updateConfirmState);

// Buttons
document.getElementById("confirm-btn").addEventListener("click", runMatching);
document.getElementById("cancel-btn").addEventListener("click", () => window.close());

updateConfirmState();
```

**`applyDefaultOrSavedStates(savedStates)`**

If `savedStates` is null (first run), apply hardcoded defaults per SPEC:
- Subject: checked
- Ignore prefix: checked
- All others: unchecked

Otherwise, apply each saved boolean to the corresponding checkbox.

**`updateConfirmState()`**

```javascript
function updateConfirmState() {
  const criteriaCheckboxIds = [
    "chk-subject", "chk-sender-full", "chk-sender-domain",
    "chk-recipient", "chk-attachment"
  ];
  // Ignore prefix is NOT a criterion on its own
  const anyChecked = criteriaCheckboxIds.some(
    id => document.getElementById(id).checked
  );
  const subjectChk = document.getElementById("chk-subject");
  const subjectInput = document.getElementById("val-subject");
  const subjectValid = !subjectChk.checked || subjectInput.value.trim().length > 0;

  document.getElementById("confirm-btn").disabled = !anyChecked || !subjectValid;
}
```

**`stripAllPrefixes(subject)`**

```javascript
function stripAllPrefixes(subject) {
  // Strip Re:, Fwd:, Fw: prefixes (case-insensitive, with or without trailing space)
  // repeatedly until no more prefixes remain
  let prev;
  do {
    prev = subject;
    subject = subject.replace(/^(re|fwd?)\s*:\s*/i, "").trimStart();
  } while (subject !== prev);
  return subject;
}
```

**`runMatching()`**

```javascript
async function runMatching() {
  document.getElementById("confirm-btn").disabled = true;
  document.getElementById("cancel-btn").disabled = true;
  document.getElementById("loading").hidden = false;

  try {
    const criteria = {
      subject: {
        enabled: document.getElementById("chk-subject").checked,
        value: document.getElementById("val-subject").value.trim(),
      },
      ignorePrefix: document.getElementById("chk-ignore-prefix").checked,
      senderFull: { enabled: document.getElementById("chk-sender-full").checked },
      senderDomain: { enabled: document.getElementById("chk-sender-domain").checked },
      recipient: { enabled: document.getElementById("chk-recipient").checked },
      hasAttachment: { enabled: document.getElementById("chk-attachment").checked },
    };

    // Enumerate all messages in the folder
    const firstPage = await messenger.messages.list(ctx.folderId);
    const allMessages = await collectAllMessages(firstPage);

    const matchedIds = [];
    for (const msg of allMessages) {
      // Pre-fetch attachments only if the criterion is enabled, to avoid unnecessary calls
      let candidateAttachments = null;
      if (criteria.hasAttachment.enabled) {
        candidateAttachments = await messenger.messages.listAttachments(msg.id);
      }
      if (messageMatchesCriteria(msg, candidateAttachments, criteria)) {
        matchedIds.push(msg.id);
      }
    }

    // Merge with current selection
    const [mailTab] = await messenger.mailTabs.query({ active: true, currentWindow: true });
    const currentPage = await messenger.mailTabs.getSelectedMessages(mailTab.tabId);
    const currentMessages = await collectAllMessages(currentPage);
    const currentIds = currentMessages.map(m => m.id);

    // Set deduplication: MessageId values are integers
    const mergedIds = [...new Set([...currentIds, ...matchedIds])];
    await messenger.mailTabs.setSelectedMessages(mailTab.tabId, mergedIds);

    window.close();
  } catch (err) {
    console.error("Select Similar: matching failed:", err);
    document.getElementById("loading").hidden = true;
    document.getElementById("confirm-btn").disabled = false;
    document.getElementById("cancel-btn").disabled = false;
  }
}
```

**`messageMatchesCriteria(msg, candidateAttachments, criteria)`**

```javascript
function messageMatchesCriteria(msg, candidateAttachments, criteria) {
  // Subject criterion
  if (criteria.subject.enabled) {
    const candidateSubject = criteria.ignorePrefix
      ? stripAllPrefixes(msg.subject)
      : msg.subject;
    if (!candidateSubject.toLowerCase().includes(criteria.subject.value.toLowerCase())) {
      return false;
    }
  }

  // Sender (full address) criterion
  if (criteria.senderFull.enabled) {
    const { email } = parseEmailAddress(msg.author);
    if (email.toLowerCase() !== senderEmail.toLowerCase()) return false;
  }

  // Sender domain criterion
  if (criteria.senderDomain.enabled) {
    const { domain } = parseEmailAddress(msg.author);
    if (domain.toLowerCase() !== senderDomain.toLowerCase()) return false;
  }

  // Recipient (To/CC) criterion — overlap check
  if (criteria.recipient.enabled) {
    const candidateRecipients = extractEmailList([...msg.recipients, ...msg.ccList]);
    const lowerRecipientEmails = recipientEmails.map(e => e.toLowerCase());
    const overlap = candidateRecipients.some(e =>
      lowerRecipientEmails.includes(e.toLowerCase())
    );
    if (!overlap) return false;
  }

  // Has attachment criterion
  if (criteria.hasAttachment.enabled) {
    const candidateHasAttachment = candidateAttachments.length > 0;
    if (candidateHasAttachment !== ctx.hasAttachment) return false;
  }

  return true;
}
```

---

## Edge cases

| Situation | Behaviour |
|---|---|
| Active folder is virtual/smart | Show error div in modal; hide criteria form |
| Zero or >1 messages selected when shortcut fires | Do nothing; do not open modal |
| No messages match criteria | Original selection unchanged (seed message preserved by merge step) |
| "Has attachment" criterion checked on a large folder | One `listAttachments` API call per message; can be slow; spinner remains visible |
| User fires shortcut twice quickly | Second invocation overwrites `pendingContext` in storage; both modals open but the second reads fresh context; acceptable |
| `getSelectedMessages` returns a MessageList requiring pagination | Always paginate, even for the "exactly 1" count check |
| `mailTabs.query()` returns empty array | Guard `if (!mailTab) return;` in both background and modal |
| `displayedFolder` absent on MailTab | Guard `if (!mailTab.displayedFolder) return;` in background |
| Subject input cleared by user after checking Subject checkbox | Confirm button becomes disabled; re-enabled on typing |

---

## Testing plan

Load as a temporary extension in Thunderbird via `about:debugging > This Thunderbird > Load Temporary Add-on` and select `manifest.json`.

| Test | Expected result |
|---|---|
| Press `Alt+Shift+S` with 0 messages selected | Nothing happens |
| Press `Alt+Shift+S` with 2+ messages selected | Nothing happens |
| Press `Alt+Shift+S` with 1 message selected in a regular folder | Modal opens |
| Press `Alt+Shift+S` with 1 message selected in Unified Inbox | Modal opens showing error message |
| Press `Alt+Shift+S` with 1 message selected in a saved search folder | Modal opens showing error message |
| Modal opens: check no criteria are checked | Confirm button disabled |
| Modal opens: check Subject but clear the input | Confirm button disabled |
| Modal opens: check Sender full, then check Sender domain | Sender full is auto-unchecked |
| Close and reopen modal | Checkbox states match previous session |
| Confirm with Subject only | Selection updated with all messages whose stripped subject contains the reference string |
| Confirm with Has attachment on folder with 1000+ messages | Selection updates (may take a few seconds) |
| Confirm with no matches | Original selection unchanged |
| Cancel | Modal closes; selection unchanged |

---

## README content (required deliverable)

The `README.md` must include:

1. Brief description of the extension
2. Installation steps (load as temporary extension via `about:debugging`)
3. Keyboard shortcut (`Alt+Shift+S`; how to remap in Thunderbird settings)
4. A short description of each matching option
5. Note on performance: "Has attachment" may be slow on large folders
6. Assumptions section (copy from SPEC.md Assumptions)
