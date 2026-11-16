# Project Agent Rules — svg-deck

## 1. Parità e Sincronizzazione Stage ↔ Presenter View
- Ogni funzionalità interattiva disponibile nello Stage (`assets/player.js`) **deve** essere disponibile e funzionare passo-passo anche nella Presenter View, mantenendo lo stato sincronizzato in tempo reale tramite `SyncBus` (`BroadcastChannel` + `localStorage` fallback con deduplicazione):
  - Navigazione completa per slide e per **tutti** gli step progressivi (`0..maxStep`, senza saltare step intermedi).
  - Selettore lingua (`-lang_...` e `<switch systemLanguage>`).
  - Selettori di gruppi radio / temi (`-g_<group>`).
  - Toggle dei layer con scorciatoia (`-s_...`) e supporto alle relative scorciatoie da tastiera.
  - Sincronizzazione bidirezionale dello stato (`state`, `nav`, `set-language`, `set-group`, `toggle-filter`, `laser`).

## 2. Build & Verifica Obbligatori
- Dopo ogni modifica ai file in `src/` o `assets/`:
  1. Eseguire `cargo test`.
  2. Eseguire `cargo build --release` e verificare la compilazione su `demo-deck/`.
- Per operazioni Git utilizzare sempre `gemgit` (mai `git`).

## 3. Documentazione (`README.md`)
- Aggiornare sempre [README.md](README.md) ogni volta che viene modificata o aggiunta una funzionalità, un'opzione CLI, una regola di parsing o un comportamento del player.

## 4. Upload con `transfer`
- Ogni caricamento effettuato tramite il comando `transfer` deve sempre impostare il limite massimo di download a 1: `transfer upload -d 1 -f <file>` (ovvero `--expiry-downloads 1`).
