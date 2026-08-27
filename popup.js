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

/* ---------- Pencarian berdasarkan nama ---------- */

function collectCandidates(tree) {
  const candidates = [];
  const stack = [...tree];

  while (stack.length > 0) {
    const node = stack.shift();

    if (!ROOT_IDS.includes(node.id)) {
      candidates.push(node);
    }

    if (node.children && node.children.length > 0) {
      stack.push(...node.children);
    }
  }

  return candidates;
}

function findMatches(candidates, query) {
  const q = query.toLowerCase();

  const exact = candidates.filter(
    (n) => (n.title || "").trim().toLowerCase() === q
  );
  if (exact.length > 0) return { isExact: true, nodes: exact };

  const partial = candidates.filter((n) =>
    (n.title || "").toLowerCase().includes(q)
  );
  return { isExact: false, nodes: partial };
}

/* ---------- Sembunyikan: hapus dari Chrome, simpan ke storage ---------- */

function serializeChildren(children) {
  return children.map((child) => {
    if (child.url) {
      return { type: "bookmark", title: child.title, url: child.url };
    }
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

/* ---------- Unhide: kembalikan ke tempat semula ---------- */

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

  if (!item) throw new Error("Item tidak ditemukan di penyimpanan.");

  const parentId = await ensureParentExists(item.parentId);

  if (item.type === "bookmark") {
    await createBookmark({
      parentId,
      title: item.title,
      url: item.url,
      index: item.index
    });
  } else {
    const folder = await createBookmark({
      parentId,
      title: item.title,
      index: item.index
    });
    await recreateChildren(folder.id, item.children || []);
  }

  await storageSet({
    hiddenItems: hiddenItems.filter((i) => i.key !== key)
  });

  return item;
}

async function unhideAll() {
  const { hiddenItems } = await storageGet();
  const sorted = [...hiddenItems].sort(
    (a, b) => (a.hiddenAt || 0) - (b.hiddenAt || 0)
  );
  for (const item of sorted) {
    await unhideItem(item.key);
  }
}

/* ---------- Backup: bertahan walau ekstensi dicopot ---------- */

async function saveBackupFile(saveAs = false) {
  const { hiddenItems } = await storageGet();

  const json = JSON.stringify(
    {
      app: "bookmark-hidden",
      version: 1,
      savedAt: Date.now(),
      hiddenItems
    },
    null,
    2
  );

  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  try {
    await new Promise((resolve, reject) => {
      chrome.downloads.download(
        {
          url: url,
          filename: BACKUP_FILENAME,
          saveAs: saveAs,
          conflictAction: "overwrite"
        },
        (downloadId) => {
          setTimeout(() => URL.revokeObjectURL(url), 2000);
          
          if (chrome.runtime.lastError) {
            return reject(new Error(chrome.runtime.lastError.message));
          }
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
  if (!Array.isArray(items)) {
    throw new Error("Format backup tidak dikenali.");
  }

  const { hiddenItems } = await storageGet();
  const existingKeys = new Set(hiddenItems.map((i) => i.key));
  let added = 0;

  for (const item of items) {
    if (!item || !item.title) continue;
    if (item.key && existingKeys.has(item.key)) continue;
    if (!item.key) {
      item.key = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }
    hiddenItems.push(item);
    added++;
  }

  await storageSet({ hiddenItems });
  return added;
}

/* ---------- Render daftar tersembunyi ---------- */

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

/* ---------- Init ---------- */

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("hide-form");
  const namesTextarea = document.getElementById("names");
  const refreshButton = document.getElementById("refresh");
  const unhideAllButton = document.getElementById("unhide-all");
  const exportButton = document.getElementById("export-backup");
  const importButton = document.getElementById("import-backup");
  const fileInput = document.getElementById("backup-file");
  const list = document.getElementById("list");

  /* ----- Multi hide ----- */
  form.addEventListener("submit", async (event) => {
    event.preventDefault();

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
        // Auto backup (tidak memblokir UI jika user cancel dialog save)
        saveBackupFile().catch(err => console.warn("Auto-backup gagal:", err.message));
      }

      await loadHiddenList();
    } catch (error) {
      setStatus(escapeHtml(error.message), true);
    }
  });

  /* ----- Unhide per item ----- */
  list.addEventListener("click", async (event) => {
    const btn = event.target.closest(".unhide-btn");
    if (!btn) return;

    try {
      const item = await unhideItem(btn.dataset.key);
      setStatus(`"${escapeHtml(item.title)}" dikembalikan ke tempat semula.`);
      await loadHiddenList();
      // (Sudah dihapus: await saveBackupFile())
    } catch (error) {
      setStatus(escapeHtml(error.message), true);
    }
  });

  /* ----- Unhide semua ----- */
  unhideAllButton.addEventListener("click", async () => {
    try {
      await unhideAll();
      setStatus("Semua bookmark dikembalikan.");
      await loadHiddenList();
    } catch (error) {
      setStatus(escapeHtml(error.message), true);
    }
  });

  /* ----- Backup: ekspor & impor ----- */
  exportButton.addEventListener("click", async () => {
    try {
      await saveBackupFile(true);
      setStatus("✅ Backup berhasil diekspor ke folder Downloads.");
    } catch (error) {
      setStatus("Gagal ekspor: " + error.message + " (Pastikan izin 'downloads' ada di manifest.json & ekstensi sudah di-reload)", true);
    }
  });

  importButton.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) return;

    try {
      const added = await importBackupFile(file);
      await loadHiddenList();
      await saveBackupFile(); // Backup otomatis setelah impor (masuk akal)
      setStatus(`Backup dimuat: ${added} item ditambahkan ke daftar tersembunyi.`);
    } catch (error) {
      setStatus(escapeHtml(error.message), true);
    }

    fileInput.value = "";
  });

  refreshButton.addEventListener("click", loadHiddenList);

  loadHiddenList();
});