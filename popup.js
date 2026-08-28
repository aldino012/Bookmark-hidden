const ROOT_IDS = ["0", "1", "2", "3"];
const LEGACY_FOLDER_NAME = "bookmark-hidden";
const BACKUP_FILENAME = "bookmark-hidden-backup.json";

/* ---------- Helper UI ---------- */

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function setStatus(message, isError = false) {
  const status = document.getElementById("status");
  status.innerHTML = message;
  status.className = isError ? "error" : "";
}

/* ---------- Crypto: Hash PIN dengan PBKDF2 ---------- */

// Fungsi tambahan untuk mengubah string hex menjadi Uint8Array (Wajib untuk Web Crypto API)
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

async function hashPin(pin, saltHex) {
  const enc = new TextEncoder();
  const saltBytes = hexToBytes(saltHex); // Ubah string hex jadi Uint8Array
  
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(pin),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: saltBytes, // INI PERBAIKANNYA: Wajib BufferSource, bukan string
      iterations: 100000,
      hash: "SHA-256"
    },
    keyMaterial,
    256
  );
  
  return Array.from(new Uint8Array(bits))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateSalt() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function setPin(pin) {
  const salt = generateSalt();
  const hash = await hashPin(pin, salt);
  await new Promise((resolve) => {
    chrome.storage.local.set({ pinHash: hash, pinSalt: salt }, resolve);
  });
}

async function verifyPin(pin) {
  const data = await new Promise((resolve) => {
    chrome.storage.local.get({ pinHash: null, pinSalt: null }, resolve);
  });
  if (!data.pinHash || !data.pinSalt) return false;
  const hash = await hashPin(pin, data.pinSalt);
  return hash === data.pinHash;
}

async function hasPin() {
  const data = await new Promise((resolve) => {
    chrome.storage.local.get({ pinHash: null }, resolve);
  });
  return !!data.pinHash;
}

async function clearPinAndData() {
  await new Promise((resolve) => {
    chrome.storage.local.clear(resolve);
  });
}

/* ---------- Wrapper chrome API -> Promise ---------- */

function getTree() {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.getTree((tree) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(tree);
    });
  });
}

function getSubTree(id) {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.getSubTree(id, (nodes) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(nodes);
    });
  });
}

function getBookmarkById(id) {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.get(id, (nodes) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(nodes);
    });
  });
}

function createBookmark(details) {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.create(details, (node) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(node);
    });
  });
}

function removeBookmark(id) {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.remove(id, () => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve();
    });
  });
}

function removeTree(id) {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.removeTree(id, () => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve();
    });
  });
}

function storageGet() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get({ hiddenItems: [] }, (result) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(result);
    });
  });
}

function storageSet(data) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(data, () => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve();
    });
  });
}

/* ---------- Pencarian ---------- */

function collectCandidates(tree) {
  const candidates = [];
  const stack = [...tree];

  while (stack.length > 0) {
    const node = stack.shift();
    if (!ROOT_IDS.includes(node.id)) candidates.push(node);
    if (node.children && node.children.length > 0) stack.push(...node.children);
  }
  return candidates;
}

function findMatches(candidates, query) {
  const q = query.toLowerCase();
  const exact = candidates.filter((n) => (n.title || "").trim().toLowerCase() === q);
  if (exact.length > 0) return { isExact: true, nodes: exact };

  const partial = candidates.filter((n) => (n.title || "").toLowerCase().includes(q));
  return { isExact: false, nodes: partial };
}

/* ---------- Hide / Unhide ---------- */

function serializeChildren(children) {
  return children.map((child) => {
    if (child.url) return { type: "bookmark", title: child.title, url: child.url };
    return {
      type: "folder",
      title: child.title,
      children: serializeChildren(child.children || [])
    };
  });
}

async function hideNode(node) {
  const record = {
    key: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: node.url ? "bookmark" : "folder",
    title: node.title,
    parentId: node.parentId,
    index: typeof node.index === "number" ? node.index : undefined,
    hiddenAt: Date.now()
  };

  if (node.url) {
    record.url = node.url;
    await removeBookmark(node.id);
  } else {
    const [subtree] = await getSubTree(node.id);
    record.children = serializeChildren(subtree.children || []);
    await removeTree(node.id);
  }

  const { hiddenItems } = await storageGet();
  hiddenItems.push(record);
  await storageSet({ hiddenItems });
  return record;
}

async function ensureParentExists(parentId) {
  if (!parentId) return "1";
  try {
    const [node] = await getBookmarkById(parentId);
    if (node && node.title === LEGACY_FOLDER_NAME) return "1";
    return parentId;
  } catch {
    return "1";
  }
}

async function recreateChildren(parentId, children) {
  for (const child of children) {
    if (child.type === "bookmark") {
      await createBookmark({ parentId, title: child.title, url: child.url });
    } else {
      const folder = await createBookmark({ parentId, title: child.title });
      await recreateChildren(folder.id, child.children || []);
    }
  }
}

async function unhideItem(key) {
  const { hiddenItems } = await storageGet();
  const item = hiddenItems.find((i) => i.key === key);
  if (!item) throw new Error("Item tidak ditemukan.");

  const parentId = await ensureParentExists(item.parentId);

  if (item.type === "bookmark") {
    await createBookmark({
      parentId,
      title: item.title,
      url: item.url,
      index: item.index
    });
  } else {
    const folder = await createBookmark({ parentId, title: item.title, index: item.index });
    await recreateChildren(folder.id, item.children || []);
  }

  await storageSet({ hiddenItems: hiddenItems.filter((i) => i.key !== key) });
  return item;
}

async function unhideAll() {
  const { hiddenItems } = await storageGet();
  const sorted = [...hiddenItems].sort((a, b) => (a.hiddenAt || 0) - (b.hiddenAt || 0));
  for (const item of sorted) await unhideItem(item.key);
}

/* ---------- Backup ---------- */

async function saveBackupFile(saveAs = false) {
  const { hiddenItems } = await storageGet();
  const json = JSON.stringify(
    { app: "bookmark-hidden", version: 1, savedAt: Date.now(), hiddenItems },
    null,
    2
  );
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  try {
    await new Promise((resolve, reject) => {
      chrome.downloads.download(
        { url, filename: BACKUP_FILENAME, saveAs, conflictAction: "overwrite" },
        (downloadId) => {
          setTimeout(() => URL.revokeObjectURL(url), 2000);
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          resolve(downloadId);
        }
      );
    });
  } catch (err) {
    throw new Error(err.message || "Gagal memicu download.");
  }
}

async function importBackupFile(file) {
  const text = await file.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("File backup tidak valid (bukan JSON).");
  }

  const items = Array.isArray(data) ? data : data.hiddenItems;
  if (!Array.isArray(items)) throw new Error("Format backup tidak dikenali.");

  const { hiddenItems } = await storageGet();
  const existingKeys = new Set(hiddenItems.map((i) => i.key));
  let added = 0;

  for (const item of items) {
    if (!item || !item.title) continue;
    if (item.key && existingKeys.has(item.key)) continue;
    if (!item.key) item.key = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    hiddenItems.push(item);
    added++;
  }

  await storageSet({ hiddenItems });
  return added;
}

/* ---------- Render daftar ---------- */

async function loadHiddenList() {
  const list = document.getElementById("list");
  list.innerHTML = "";

  const { hiddenItems } = await storageGet();
  if (hiddenItems.length === 0) {
    const li = document.createElement("li");
    li.textContent = "Belum ada bookmark tersembunyi.";
    list.appendChild(li);
    return;
  }

  for (const item of hiddenItems) {
    const li = document.createElement("li");

    const titleSpan = document.createElement("span");
    titleSpan.textContent = item.title || "(tanpa nama)";
    li.appendChild(titleSpan);

    if (item.type === "folder") {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "[folder]";
      li.appendChild(badge);
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "unhide-btn";
    btn.dataset.key = item.key;
    btn.textContent = "Unhide";
    li.appendChild(btn);

    list.appendChild(li);
  }
}

/* ---------- PIN Modal Controller ---------- */

let currentSessionUnlocked = false;

function showModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove("hidden");
}

function hideModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add("hidden");
}

function showPinError(elementId, msg) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
}

function hidePinError(elementId) {
  const el = document.getElementById(elementId);
  if (el) el.classList.add("hidden");
}

async function showSetupModal() {
  const titleEl = document.getElementById("pin-modal-title");
  const descEl = document.getElementById("pin-modal-desc");
  if (titleEl) titleEl.textContent = "Buat PIN Baru";
  if (descEl) descEl.textContent = "PIN digunakan untuk melindungi daftar bookmark tersembunyi Anda. Minimal 4 digit.";
  
  document.getElementById("pin-confirm")?.classList.remove("hidden");
  document.getElementById("pin-reset")?.classList.add("hidden");
  
  const submitBtn = document.getElementById("pin-submit");
  if (submitBtn) submitBtn.textContent = "Simpan PIN";
  
  const pinIn = document.getElementById("pin-input");
  const pinConf = document.getElementById("pin-confirm");
  if (pinIn) pinIn.value = "";
  if (pinConf) pinConf.value = "";
  
  hidePinError("pin-error");
  showModal("pin-modal");
  setTimeout(() => pinIn?.focus(), 100);
}

async function showLoginModal() {
  const titleEl = document.getElementById("pin-modal-title");
  const descEl = document.getElementById("pin-modal-desc");
  if (titleEl) titleEl.textContent = "Masukkan PIN";
  if (descEl) descEl.textContent = "Buka brankas untuk melihat dan mengelola bookmark tersembunyi Anda.";
  
  document.getElementById("pin-confirm")?.classList.add("hidden");
  document.getElementById("pin-reset")?.classList.remove("hidden");
  
  const submitBtn = document.getElementById("pin-submit");
  if (submitBtn) submitBtn.textContent = "Buka";
  
  const pinIn = document.getElementById("pin-input");
  if (pinIn) pinIn.value = "";
  
  hidePinError("pin-error");
  showModal("pin-modal");
  setTimeout(() => pinIn?.focus(), 100);
}

function requestPinVerification(description) {
  return new Promise((resolve, reject) => {
    const descEl = document.getElementById("verify-desc");
    if (descEl) descEl.textContent = description;
    
    const input = document.getElementById("verify-input");
    if (input) input.value = "";
    
    hidePinError("verify-error");
    showModal("verify-modal");
    setTimeout(() => input?.focus(), 100);

    const submitBtn = document.getElementById("verify-submit");
    const cancelBtn = document.getElementById("verify-cancel");

    const cleanup = () => {
      if (submitBtn) submitBtn.onclick = null;
      if (cancelBtn) cancelBtn.onclick = null;
      if (input) input.onkeydown = null;
      hideModal("verify-modal");
    };

    if (submitBtn) {
      submitBtn.onclick = async () => {
        const pin = input.value;
        const ok = await verifyPin(pin);
        if (ok) {
          cleanup();
          resolve();
        } else {
          showPinError("verify-error", "PIN salah. Coba lagi.");
          input.value = "";
          input.focus();
        }
      };
    }

    if (cancelBtn) {
      cancelBtn.onclick = () => {
        cleanup();
        reject(new Error("Dibatalkan"));
      };
    }

    if (input) {
      input.onkeydown = (e) => {
        if (e.key === "Enter" && submitBtn) submitBtn.click();
      };
    }
  });
}

/* ---------- Init ---------- */

document.addEventListener("DOMContentLoaded", async () => {
  const form = document.getElementById("hide-form");
  const namesTextarea = document.getElementById("names");
  const refreshButton = document.getElementById("refresh");
  const unhideAllButton = document.getElementById("unhide-all");
  const exportButton = document.getElementById("export-backup");
  const importButton = document.getElementById("import-backup");
  const fileInput = document.getElementById("backup-file");
  const changePinBtn = document.getElementById("change-pin");
  const lockBtn = document.getElementById("lock-btn");
  const list = document.getElementById("list");

  const pinInput = document.getElementById("pin-input");
  const pinConfirm = document.getElementById("pin-confirm");
  const pinSubmit = document.getElementById("pin-submit");
  const pinReset = document.getElementById("pin-reset");

  // Cek status PIN saat startup
  const pinExists = await hasPin();
  document.body.classList.add("locked");

  if (!pinExists) {
    await showSetupModal();
  } else {
    await showLoginModal();
  }

  /* ----- Handler tombol utama di PIN modal ----- */
  if (pinSubmit) {
    pinSubmit.onclick = async () => {
      const pin = pinInput.value;
      const pinExistedBefore = await hasPin();

      if (!pinExistedBefore) {
        // Mode: Buat PIN baru
        const confirm = pinConfirm ? pinConfirm.value : "";
        if (pin.length < 4) {
          showPinError("pin-error", "PIN minimal 4 digit.");
          return;
        }
        if (pin !== confirm) {
          showPinError("pin-error", "Konfirmasi PIN tidak cocok.");
          return;
        }
        await setPin(pin);
        currentSessionUnlocked = true;
        hideModal("pin-modal");
        document.body.classList.remove("locked");
        setStatus("✅ PIN berhasil dibuat. Brankas terbuka.");
        await loadHiddenList();
      } else {
        // Mode: Login
        const ok = await verifyPin(pin);
        if (!ok) {
          showPinError("pin-error", "PIN salah.");
          pinInput.value = "";
          pinInput.focus();
          return;
        }
        currentSessionUnlocked = true;
        hideModal("pin-modal");
        document.body.classList.remove("locked");
        await loadHiddenList();
      }
    };
  }

  if (pinReset) {
    pinReset.onclick = async () => {
      if (!confirm(
        "Hapus PIN dan SEMUA data bookmark tersembunyi?\n\n" +
        "Bookmark yang sudah disembunyikan TIDAK BISA dikembalikan ke tempat semula. " +
        "Tindakan ini tidak bisa dibatalkan."
      )) return;

      await clearPinAndData();
      currentSessionUnlocked = false;
      hideModal("pin-modal");
      setStatus("Semua data dihapus. Silakan buat PIN baru.");
      await showSetupModal();
    };
  }

  if (pinInput) {
    pinInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && pinSubmit) pinSubmit.click();
    });
  }
  
  if (pinConfirm) {
    pinConfirm.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && pinSubmit) pinSubmit.click();
    });
  }

  /* ----- Multi hide ----- */
  if (form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!currentSessionUnlocked) return;

      const rawText = namesTextarea.value;
      const queries = rawText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      if (queries.length === 0) {
        setStatus("Masukkan minimal satu nama bookmark.", true);
        return;
      }

      const uniqueQueries = [...new Set(queries)];

      try {
        const tree = await getTree();
        const candidates = collectCandidates(tree);

        const success = [];
        const notFound = [];
        const ambiguous = [];
        const failed = [];

        for (const query of uniqueQueries) {
          try {
            const { isExact, nodes: matches } = findMatches(candidates, query);

            if (matches.length === 0) {
              notFound.push(query);
              continue;
            }
            if (!isExact && matches.length > 1) {
              ambiguous.push({
                query,
                suggestions: matches.slice(0, 5).map((n) => n.title)
              });
              continue;
            }

            const target = matches[0];
            await hideNode(target);

            const idx = candidates.findIndex((c) => c.id === target.id);
            if (idx !== -1) candidates.splice(idx, 1);

            success.push(target.title);
          } catch (err) {
            failed.push({ query, error: err.message });
          }
        }

        const parts = [];
        if (success.length > 0) {
          parts.push(
            `<div class="result-success">✅ <strong>Berhasil (${success.length}):</strong> ${success
              .map((n) => `"${escapeHtml(n)}"`)
              .join(", ")}</div>`
          );
        }
        if (notFound.length > 0) {
          parts.push(
            `<div class="result-notfound">❌ <strong>Tidak ditemukan (${notFound.length}):</strong> ${notFound
              .map((n) => `"${escapeHtml(n)}"`)
              .join(", ")}</div>`
          );
        }
        if (ambiguous.length > 0) {
          const ambList = ambiguous
            .map(
              (a) =>
                `"${escapeHtml(a.query)}" → mungkin: ${a.suggestions
                  .map((s) => `"${escapeHtml(s)}"`)
                  .join(", ")}`
            )
            .join("<br>");
          parts.push(
            `<div class="result-ambiguous">⚠️ <strong>Ambigu (${ambiguous.length}):</strong><br>${ambList}</div>`
          );
        }
        if (failed.length > 0) {
          parts.push(
            `<div class="result-failed">🔥 <strong>Gagal (${failed.length}):</strong> ${failed
              .map((f) => `"${escapeHtml(f.query)}" (${escapeHtml(f.error)})`)
              .join(", ")}</div>`
          );
        }

        setStatus(parts.join(""), false);

        if (success.length > 0) {
          namesTextarea.value = "";
          namesTextarea.focus();
        }

        await loadHiddenList();
      } catch (error) {
        setStatus(escapeHtml(error.message), true);
      }
    });
  }

  /* ----- Unhide per item ----- */
  if (list) {
    list.addEventListener("click", async (event) => {
      const btn = event.target.closest(".unhide-btn");
      if (!btn || !currentSessionUnlocked) return;

      try {
        const item = await unhideItem(btn.dataset.key);
        setStatus(`"${escapeHtml(item.title)}" dikembalikan ke tempat semula.`);
        await loadHiddenList();
      } catch (error) {
        setStatus(escapeHtml(error.message), true);
      }
    });
  }

  /* ----- Unhide semua ----- */
  if (unhideAllButton) {
    unhideAllButton.addEventListener("click", async () => {
      if (!currentSessionUnlocked) return;

      if (!confirm("Yakin ingin mengembalikan SEMUA bookmark tersembunyi ke tempat semula?")) return;

      try {
        await unhideAll();
        setStatus("Semua bookmark dikembalikan.");
        await loadHiddenList();
      } catch (error) {
        setStatus(escapeHtml(error.message), true);
      }
    });
  }

  /* ----- Ekspor (butuh PIN tambahan sebagai double-lock) ----- */
  if (exportButton) {
    exportButton.addEventListener("click", async () => {
      try {
        await requestPinVerification(
          "Masukkan PIN untuk mengekspor file backup yang berisi data sensitif."
        );
        await saveBackupFile(true);
        setStatus("✅ Backup berhasil diekspor.");
      } catch (error) {
        if (error.message !== "Dibatalkan") {
          setStatus("Gagal ekspor: " + error.message, true);
        }
      }
    });
  }

  /* ----- Impor (butuh PIN tambahan) ----- */
  if (importButton) {
    importButton.addEventListener("click", async () => {
      try {
        await requestPinVerification(
          "Masukkan PIN untuk mengimpor file backup."
        );
        if (fileInput) fileInput.click();
      } catch (error) {
        // User membatalkan, abaikan
      }
    });
  }

  if (fileInput) {
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files[0];
      if (!file) return;

      try {
        const added = await importBackupFile(file);
        await loadHiddenList();
        setStatus(`Backup dimuat: ${added} item ditambahkan.`);
      } catch (error) {
        setStatus(escapeHtml(error.message), true);
      }
      fileInput.value = "";
    });
  }

  /* ----- Ubah PIN ----- */
  if (changePinBtn) {
    changePinBtn.addEventListener("click", async () => {
      try {
        await requestPinVerification("Masukkan PIN lama untuk mengubah PIN.");
        await new Promise((resolve) => {
          chrome.storage.local.remove(["pinHash", "pinSalt"], resolve);
        });
        await showSetupModal();
      } catch (error) {
        // Dibatalkan
      }
    });
  }

  /* ----- Kunci Manual ----- */
  if (lockBtn) {
    lockBtn.addEventListener("click", () => {
      currentSessionUnlocked = false;
      document.body.classList.add("locked");
      setStatus("");
      if (list) list.innerHTML = "";
      showLoginModal();
    });
  }

  if (refreshButton) {
    refreshButton.addEventListener("click", loadHiddenList);
  }
});