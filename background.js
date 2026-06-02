messenger.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "open-select-similar") return;

  try {
    const [mailTab] = await messenger.mailTabs.query({ active: true, currentWindow: true });
    if (!mailTab || !mailTab.displayedFolder) return;

    const folder = mailTab.displayedFolder;
    const folderIsVirtual = folder.isVirtual || folder.isTag || folder.isUnified;

    // Check selection count before doing anything else, unless virtual (we still want
    // to open the modal to show the error — but only if something is selected so
    // the user gets feedback rather than silence).
    const firstSelectionPage = await messenger.mailTabs.getSelectedMessages(mailTab.tabId);
    const selectedMessages = await collectAllMessages(firstSelectionPage);

    if (!folderIsVirtual && selectedMessages.length !== 1) return;
    if (folderIsVirtual && selectedMessages.length === 0) return;

    let context;

    if (folderIsVirtual) {
      context = { folderIsVirtual: true };
    } else {
      const msg = selectedMessages[0];
      const attachments = await messenger.messages.listAttachments(msg.id);

      context = {
        tabId: mailTab.tabId,
        folderId: folder.id,
        folderIsVirtual: false,
        messageId: msg.id,
        subject: msg.subject,
        author: msg.author,
        // recipients and ccList are MailBoxHeaderString[] — passed raw, parsed in modal
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
  } catch (err) {
    console.error("Select Similar: background handler failed:", err);
  }
});

// Paginates a MessageList to completion and returns a flat MessageHeader array.
async function collectAllMessages(firstPage) {
  const all = [...firstPage.messages];
  let page = firstPage;
  while (page.id !== null) {
    page = await messenger.messages.continueList(page.id);
    all.push(...page.messages);
  }
  return all;
}
