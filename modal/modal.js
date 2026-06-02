let ctx = null;

document.addEventListener("DOMContentLoaded", async () => {
  // Cancel always closes — wire it before anything async so it works even if init fails
  document.getElementById("cancel-btn").addEventListener("click", () => window.close());

  try {
    await init();
  } catch (err) {
    console.error("Select Similar: modal init failed:", err);
  }
});

async function init() {
  const result = await messenger.storage.local.get("selectSimilar.pendingContext");
  ctx = result["selectSimilar.pendingContext"] ?? null;
  // Remove immediately so stale context doesn't persist if the window closes unexpectedly
  await messenger.storage.local.remove("selectSimilar.pendingContext");

  if (!ctx) {
    window.close();
    return;
  }

  if (ctx.folderIsVirtual) {
    document.getElementById("error-message").textContent =
      "Select Similar only works in regular mail folders.";
    document.getElementById("error-state").hidden = false;
    // confirm-btn stays hidden; Cancel closes the window
    return;
  }

  // Parse raw MailBoxHeaderStrings
  const { email: senderEmail, domain: senderDomain } = parseEmailAddress(ctx.author);
  const recipientEmails = extractEmailList([...ctx.recipients, ...ctx.ccList]);

  // Populate value fields
  document.getElementById("val-subject").value      = stripAllPrefixes(ctx.subject);
  document.getElementById("val-sender-full").value  = senderEmail;
  document.getElementById("val-sender-domain").value = senderDomain;
  document.getElementById("val-recipient").value    = recipientEmails.join(", ");
  document.getElementById("val-attachment").value   = ctx.hasAttachment ? "Yes" : "No";

  // Restore saved checkbox states, or apply defaults on first run
  const stateResult = await messenger.storage.local.get("selectSimilar.checkboxStates");
  applyCheckboxStates(stateResult["selectSimilar.checkboxStates"] ?? null);

  wireListeners();
  updateFieldEditability();
  updateConfirmState();

  document.getElementById("criteria-form").hidden = false;
  document.getElementById("confirm-btn").hidden   = false;
}

function wireListeners() {
  const chkSenderFull   = document.getElementById("chk-sender-full");
  const chkSenderDomain = document.getElementById("chk-sender-domain");

  // Sender full and Sender domain are mutually exclusive
  chkSenderFull.addEventListener("change", () => {
    if (chkSenderFull.checked) chkSenderDomain.checked = false;
    updateFieldEditability();
    updateConfirmState();
    saveCheckboxStates();
  });
  chkSenderDomain.addEventListener("change", () => {
    if (chkSenderDomain.checked) chkSenderFull.checked = false;
    updateFieldEditability();
    updateConfirmState();
    saveCheckboxStates();
  });

  ["chk-subject", "chk-ignore-prefix", "chk-recipient", "chk-attachment"].forEach(id => {
    document.getElementById(id).addEventListener("change", () => {
      updateFieldEditability();
      updateConfirmState();
      saveCheckboxStates();
    });
  });

  // Re-evaluate confirm state on every keystroke in any text field
  ["val-subject", "val-sender-full", "val-sender-domain", "val-recipient", "val-attachment"]
    .forEach(id => document.getElementById(id).addEventListener("input", updateConfirmState));

  document.getElementById("confirm-btn").addEventListener("click", runMatching);
}

// Toggle readonly on value fields based on whether their checkbox is checked.
// Subject is always editable; the others start readonly and unlock when checked.
function updateFieldEditability() {
  const pairs = [
    ["chk-sender-full",   "val-sender-full"],
    ["chk-sender-domain", "val-sender-domain"],
    ["chk-recipient",     "val-recipient"],
    ["chk-attachment",    "val-attachment"],
  ];
  for (const [chkId, valId] of pairs) {
    document.getElementById(valId).readOnly = !document.getElementById(chkId).checked;
  }
}

function applyCheckboxStates(saved) {
  const defaults = {
    subject:       true,
    ignorePrefix:  true,
    senderFull:    false,
    senderDomain:  false,
    recipient:     false,
    hasAttachment: false,
  };
  const states = saved ?? defaults;

  document.getElementById("chk-subject").checked       = states.subject       ?? defaults.subject;
  document.getElementById("chk-ignore-prefix").checked = states.ignorePrefix  ?? defaults.ignorePrefix;
  document.getElementById("chk-sender-full").checked   = states.senderFull    ?? defaults.senderFull;
  document.getElementById("chk-sender-domain").checked = states.senderDomain  ?? defaults.senderDomain;
  document.getElementById("chk-recipient").checked     = states.recipient     ?? defaults.recipient;
  document.getElementById("chk-attachment").checked    = states.hasAttachment ?? defaults.hasAttachment;
}

async function saveCheckboxStates() {
  const states = {
    subject:       document.getElementById("chk-subject").checked,
    ignorePrefix:  document.getElementById("chk-ignore-prefix").checked,
    senderFull:    document.getElementById("chk-sender-full").checked,
    senderDomain:  document.getElementById("chk-sender-domain").checked,
    recipient:     document.getElementById("chk-recipient").checked,
    hasAttachment: document.getElementById("chk-attachment").checked,
  };
  await messenger.storage.local.set({ "selectSimilar.checkboxStates": states });
}

// Disable Confirm if no criteria are checked, or if Subject is checked but empty.
// "Ignore Re:/Fwd: prefixes" is not a criterion on its own.
function updateConfirmState() {
  const criteriaIds = [
    "chk-subject", "chk-sender-full", "chk-sender-domain",
    "chk-recipient", "chk-attachment",
  ];
  const anyChecked  = criteriaIds.some(id => document.getElementById(id).checked);
  const subjectChk  = document.getElementById("chk-subject").checked;
  const subjectVal  = document.getElementById("val-subject").value.trim();
  const subjectValid = !subjectChk || subjectVal.length > 0;

  document.getElementById("confirm-btn").disabled = !anyChecked || !subjectValid;
}

async function runMatching() {
  document.getElementById("confirm-btn").disabled = true;
  document.getElementById("cancel-btn").disabled  = true;
  document.getElementById("loading").hidden        = false;

  try {
    const criteria = buildCriteria();

    // Enumerate every message in the folder via the list/continueList pagination pattern
    const firstPage   = await messenger.messages.list(ctx.folderId);
    const allMessages = await collectAllMessages(firstPage);

    const matchedIds = [];
    for (const msg of allMessages) {
      // Only call listAttachments when that criterion is enabled — one extra API call
      // per message; can be slow on large folders
      let candidateAttachments = null;
      if (criteria.hasAttachment.enabled) {
        candidateAttachments = await messenger.messages.listAttachments(msg.id);
      }
      if (messageMatchesCriteria(msg, candidateAttachments, criteria)) {
        matchedIds.push(msg.id);
      }
    }

    // setSelectedMessages REPLACES the selection, so fetch the current selection first
    // and merge. Use ctx.tabId — querying mailTabs from a popup window returns nothing
    // because the popup itself is the active window and has no mail tabs.
    const currentPage     = await messenger.mailTabs.getSelectedMessages(ctx.tabId);
    const currentMessages = await collectAllMessages(currentPage);
    const currentIds      = currentMessages.map(m => m.id);

    const mergedIds = [...new Set([...currentIds, ...matchedIds])];
    await messenger.mailTabs.setSelectedMessages(ctx.tabId, mergedIds);

    window.close();
  } catch (err) {
    console.error("Select Similar: matching failed:", err);
    document.getElementById("loading").hidden        = true;
    document.getElementById("confirm-btn").disabled  = false;
    document.getElementById("cancel-btn").disabled   = false;
  }
}

// Read current field values into a criteria object so matching uses whatever
// the user has typed, not the original extracted values.
function buildCriteria() {
  return {
    subject: {
      enabled: document.getElementById("chk-subject").checked,
      value:   document.getElementById("val-subject").value.trim(),
    },
    ignorePrefix: document.getElementById("chk-ignore-prefix").checked,
    senderFull: {
      enabled: document.getElementById("chk-sender-full").checked,
      value:   document.getElementById("val-sender-full").value.trim(),
    },
    senderDomain: {
      enabled: document.getElementById("chk-sender-domain").checked,
      value:   document.getElementById("val-sender-domain").value.trim(),
    },
    recipient: {
      enabled: document.getElementById("chk-recipient").checked,
      // Support comma-separated edits: split and filter blanks
      values:  document.getElementById("val-recipient").value
                 .split(",").map(s => s.trim()).filter(Boolean),
    },
    hasAttachment: {
      enabled: document.getElementById("chk-attachment").checked,
      // Read from the (potentially edited) field: "Yes" → true, anything else → false
      value:   document.getElementById("val-attachment").value.trim().toLowerCase() === "yes",
    },
  };
}

function messageMatchesCriteria(msg, candidateAttachments, criteria) {
  if (criteria.subject.enabled) {
    // Strip prefixes from candidate subject when ignorePrefix is on;
    // the reference value (criteria.subject.value) is used exactly as entered
    const candidateSubject = criteria.ignorePrefix
      ? stripAllPrefixes(msg.subject)
      : msg.subject;
    if (!candidateSubject.toLowerCase().includes(criteria.subject.value.toLowerCase())) {
      return false;
    }
  }

  if (criteria.senderFull.enabled) {
    const { email } = parseEmailAddress(msg.author);
    if (email.toLowerCase() !== criteria.senderFull.value.toLowerCase()) return false;
  }

  if (criteria.senderDomain.enabled) {
    const { domain } = parseEmailAddress(msg.author);
    if (domain.toLowerCase() !== criteria.senderDomain.value.toLowerCase()) return false;
  }

  if (criteria.recipient.enabled) {
    // Overlap check: any of the candidate's To/CC addresses must appear in the reference list
    const candidateRecipients = extractEmailList([...msg.recipients, ...msg.ccList]);
    const hasOverlap = candidateRecipients.some(e =>
      criteria.recipient.values.some(ref => ref.toLowerCase() === e.toLowerCase())
    );
    if (!hasOverlap) return false;
  }

  if (criteria.hasAttachment.enabled) {
    if ((candidateAttachments.length > 0) !== criteria.hasAttachment.value) return false;
  }

  return true;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Extracts plain email address and domain from a MailBoxHeaderString.
// Handles: "Name <user@domain.com>", "<user@domain.com>", "user@domain.com"
function parseEmailAddress(mailboxString) {
  const angleMatch = mailboxString.match(/<([^<>\s]+@[^<>\s>]+)>/);
  const email = angleMatch ? angleMatch[1].trim() : mailboxString.trim();
  const atIndex = email.lastIndexOf("@");
  const domain = atIndex !== -1 ? email.slice(atIndex + 1) : "";
  return { email, domain };
}

// Maps an array of MailBoxHeaderStrings to plain email address strings.
function extractEmailList(mailboxStrings) {
  return mailboxStrings.map(s => parseEmailAddress(s).email).filter(Boolean);
}

// Removes Re:, Fwd:, Fw: prefixes repeatedly (case-insensitive) until none remain.
function stripAllPrefixes(subject) {
  let prev;
  do {
    prev = subject;
    subject = subject.replace(/^(re|fwd?)\s*:\s*/i, "").trimStart();
  } while (subject !== prev);
  return subject;
}

// Paginates a MessageList to completion. Returns a flat array of MessageHeaders.
async function collectAllMessages(firstPage) {
  const all = [...firstPage.messages];
  let page = firstPage;
  while (page.id !== null) {
    page = await messenger.messages.continueList(page.id);
    all.push(...page.messages);
  }
  return all;
}
