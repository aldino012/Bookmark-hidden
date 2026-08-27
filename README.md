# Bookmark Hidden 🔒

Chrome extension untuk **benar-benar menyembunyikan** bookmark & folder
dari browser. Bookmark yang disembunyikan dihapus dari tampilan Chrome
(bookmark bar, menu, dan Bookmark Manager), datanya disimpan secara
lokal di penyimpanan ekstensi, dan bisa dikembalikan ke tempat semula
kapan saja.

## ✨ Features

- 🙈 **Truly hidden** – bookmark hilang total dari semua tampilan Chrome
- 🔤 **Hide by name** – cukup ketik nama bookmark/foldernya
- 📋 **Multi hide** – sembunyikan banyak bookmark sekaligus (satu nama per baris)
- 📁 **Hide folder** – sembunyikan seluruh folder beserta isinya
- ↩️ **Unhide** – kembalikan ke lokasi & posisi semula
- 🛡️ **Safe matching** – nama ambigu tidak akan di-hide, tapi ditampilkan sebagai saran

## 🚀 Installation

1. Clone atau download repo ini
2. Buka `chrome://extensions`
3. Aktifkan **Developer mode** (pojok kanan atas)
4. Klik **Load unpacked**
5. Pilih folder project ini
6. Klik ikon ekstensi dan mulai sembunyikan bookmark!

## 💡 How to Use

**Hide:** ketik nama (boleh banyak, satu per baris) → klik *Sembunyikan Semua*
**Unhide:** klik tombol *Unhide* pada daftar, atau *Unhide Semua*

## 🔧 How it Works

1. Ekstensi mencari bookmark/folder berdasarkan nama
2. Bookmark **dihapus dari Chrome**, tapi datanya (nama, URL, lokasi asal,
   struktur folder) direkam di `chrome.storage.local`
3. Saat *unhide*, bookmark dibuat ulang di lokasi semula

## 🗺️ Roadmap

- [ ] Simpan & muat preset (sekali klik hide/unhide sekelompok bookmark)
- [ ] Proteksi PIN/password
- [ ] Enkripsi data tersembunyi
- [ ] Keyboard shortcut (panic button)
- [ ] Auto-hide berdasarkan jam

## ⚠️ Privacy

Semua data tersimpan **lokal** di browser. Tidak ada data yang dikirim
ke server mana pun.

## 📄 License

MIT