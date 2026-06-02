# Select Similar — Extension Specification

## Overview

A Thunderbird MailExtension. When exactly one email is selected in the message list, a keyboard shortcut opens a criteria modal. On confirmation, all messages in the current folder matching the selected criteria are added to the current selection.

---

## Target environment

- Thunderbird 151+ (stable channel)
- Manifest Version: **3** (confirmed against webextension-api.thunderbird.net)
- Standard WebExtension — no external dependencies, vanilla JS only
- Namespace: `messenger.*` throughout (equivalent to `browser.*`; `messenger` is preferred for Thunderbird extensions)

---

## Keyboard shortcut

- **Default:** `Alt+Shift+S`
- Registered in `manifest.json` under `commands` so the user can remap it via Thunderbird's built-in keyboard shortcut settings
- Command name: `"open-select-similar"`
- Fires only when exactly one message is selected in the active mail tab
- If zero or more than one message is selected: do nothing silently (no error, no notification)

---

## Triggering the modal

Before opening the modal the background script must:

1. Get the active mail tab and its displayed folder.
2. Detect virtual/smart folders — see "Virtual folder handling" below.
3. Paginate through `getSelectedMessages()` to get the full selection count. If the count is not exactly 1, return without opening the modal.
4. For the single selected message: read its `MessageHeader` fields and call `listAttachments()` to determine attachment status.
5. Write a context object to `storage.local` under `"selectSimilar.pendingContext"`.
6. Call `windows.create()` to open the modal popup.

---

## Modal

Opened via `messenger.windows.create()` as a popup window (`type: "popup"`), **520 × 420 px** (accounts for OS window chrome).

URL: extension-internal `modal/modal.html`.

### Layout

Six criteria rows, each containing a checkbox and a label. Most rows also show a read-only value field. One row ("Ignore Re:/Fwd: prefixes") has no value field — it modifies how the Subject criterion is applied.

| # | Checkbox label | Default state | Value field type | Initial value |
|---|---|---|---|---|
| 1 | Subject (contains) | **checked** | Editable `<input type="text">` | Stripped base subject (all Re:/Fwd:/Fw: prefixes removed) |
| 2 | Ignore Re: / Fwd: prefixes | **checked** | None | — |
| 3 | Sender (full address) | unchecked | Read-only text | Full sender email address |
| 4 | Sender domain only | unchecked | Read-only text | Domain portion of sender address (part after `@`) |
| 5 | Recipient (To / CC) | unchecked | Read-only text | Comma-separated list of all To and CC addresses |
| 6 | Has attachment | unchecked | Read-only text | "Yes" or "No" |

Buttons below the rows:
- **Select Similar** (primary; subject to disabled rules — see below)
- **Cancel**

### Subject field behaviour

- On open: pre-populate with the fully stripped subject (all Re:/Fwd:/Fw: prefixes removed, regardless of whether row 2 is checked — the stripped value is always shown as the reference).
- The user may edit this value freely before confirming.
- If the Subject checkbox is checked but the input is empty or whitespace-only, the Confirm button must be disabled.
- At match time: use `subjectInput.value.trim()` exactly as entered. Do not re-strip.

### Mutual exclusivity

"Sender (full address)" and "Sender domain only" are mutually exclusive. Checking one must automatically uncheck the other.

### Confirm button disabled rules

The "Select Similar" button must be disabled when **either** of the following is true:

- No criterion checkbox is checked. The "Ignore Re:/Fwd: prefixes" toggle does not count as a criterion on its own.
- The Subject checkbox is checked but its input is empty or whitespace-only.

Criteria checkboxes for this rule: Subject, Sender (full address), Sender domain only, Recipient, Has attachment.

### Error state (virtual folder)

If the active folder is virtual/smart, show an error message inside the modal **instead** of the criteria form:

> "Select Similar only works in regular mail folders."

Show a single "Close" button. Hide the criteria form entirely.

### Loading state

While folder enumeration and matching is running (after the user clicks Confirm), show a loading spinner and disable the Confirm button. The modal must not close until matching and selection are complete.

---

## Virtual folder detection

A folder is considered virtual/smart if any of these properties is true on the `MailFolder` object:

- `folder.isVirtual === true`
- `folder.isTag === true`
- `folder.isUnified === true`

---

## Settings persistence

Persist **checkbox states only** (not field values) via `messenger.storage.local` under the key `"selectSimilar.checkboxStates"`.

On next invocation: restore saved checkbox states. Field values are always re-extracted fresh from the currently selected email.

Default states (used on first invocation when no saved state exists):

| Checkbox | Default |
|---|---|
| Subject | checked |
| Ignore Re:/Fwd: prefixes | checked |
| Sender (full address) | unchecked |
| Sender domain only | unchecked |
| Recipient (To/CC) | unchecked |
| Has attachment | unchecked |

---

## Matching logic

### Folder enumeration

Enumerate ALL messages in the current folder using the pagination pattern:

```
page = messages.list(folderId)
collect page.messages
while page.id !== null:
    page = messages.continueList(page.id)
    collect page.messages
```

Do not assume all messages fit in the first page.

### Criterion evaluation — AND logic

A candidate message must satisfy ALL checked criteria to be included. The "Ignore Re:/Fwd: prefixes" toggle modifies how Subject matching works but is not an independent criterion.

---

### Subject (contains)

1. Take `subjectInput.value.trim()` as the reference string.
2. If "Ignore Re:/Fwd: prefixes" is checked, strip the following prefixes from the **candidate** subject before comparing. Strip repeatedly (case-insensitive) until none remain: `Re:`, `Fwd:`, `Fw:` — handle both with and without a trailing space. Trim whitespace after each strip.
3. Check whether the candidate's processed subject **contains** the reference string (case-insensitive substring match).

The reference string is NOT re-stripped at match time. Whatever the user typed in the Subject input is used verbatim.

Prefix stripping pseudocode:
```
function stripAllPrefixes(subject):
    loop:
        prev = subject
        subject = subject.replace(/^(re|fwd?)\s*:\s*/i, "").trimStart()
        if subject === prev: break
    return subject
```

---

### Sender (full address)

Extract the email address from the candidate's `author` field (a `MailBoxHeaderString`). Compare case-insensitively against the reference sender email.

Exact match required.

---

### Sender domain only

Extract the domain (part after `@`) from the candidate's `author` field. Compare case-insensitively against the reference sender domain.

---

### Recipient (To / CC)

Match if **at least one** address in the candidate's `recipients` + `ccList` fields matches **at least one** address in the reference email's `recipients` + `ccList` fields. Case-insensitive exact address match.

This is an overlap check, not an exact list match.

---

### Has attachment

The reference attachment status is a boolean (true = has one or more attachments).

A candidate matches if its attachment status equals the reference status:
- Reference has attachments → select candidates that also have attachments.
- Reference has no attachments → select candidates that also have no attachments.

Attachment presence is determined by calling `messenger.messages.listAttachments(messageId)` and checking whether the returned array is non-empty. There is no `hasAttachment` flag on `MessageHeader`.

**Performance note:** Checking attachments requires one API call per candidate message. On large folders this will be slow. The loading spinner must remain visible for the duration.

---

## Adding to the selection

After matching:

1. Fetch the current selected messages via `mailTabs.getSelectedMessages()` (paginate if needed).
2. Combine their IDs with the matched message IDs.
3. Deduplicate using a `Set`.
4. Call `mailTabs.setSelectedMessages(tabId, mergedIds)` with the combined array.

`setSelectedMessages` **replaces** the entire selection; it does not add to it. The fetch-merge-set pattern is therefore mandatory.

If no messages match, the original single selected message remains selected (it was in the current selection, which is preserved by the merge step).

---

## Completion

No notification, badge, or count after selection completes. The modal closes silently.

---

## Permissions required

```json
["accountsRead", "messagesRead", "storage"]
```

- `accountsRead` — required to read `MailTab.displayedFolder` and `MessageHeader.folder`
- `messagesRead` — required for `messages.list()`, `messages.continueList()`, `mailTabs.getSelectedMessages()`, `mailTabs.setSelectedMessages()`, `messages.listAttachments()`
- `storage` — required for `storage.local`

---

## Assumptions

The following are not explicitly defined in the spec and have been resolved as follows:

1. **Recipient matching** is an overlap check. A candidate matches if ANY of its To/CC addresses is found in the seed message's To/CC list. An exact set match would be too strict to be useful.

2. **"Has attachment" matching** selects candidates with the same attachment status as the seed (matching none-to-none as well as some-to-some).

3. **Subject "contains"** means case-insensitive substring match, not a whole-word or exact match.

4. **The seed message is always included in the result** because it is in the folder, satisfies its own criteria, and is present in both the original selection and the matched set. This is correct and expected behaviour.

5. **`pendingContext` storage cleanup:** the modal removes the `"selectSimilar.pendingContext"` key from `storage.local` after reading it, to avoid stale state persisting between sessions.

6. **No progress count or notification** after selection completes — silent update per spec.

---

## Out of scope

- Multiple simultaneous modal windows (only one invocation expected at a time; overwriting `pendingContext` on rapid re-invocation is acceptable)
- Cross-folder search
- Saved search presets
- Any UI beyond the single modal popup
