# Project Agent Rules — Slidesv

## 1. Parità e Sincronizzazione `index.html` ↔ Presenter View
- Ogni funzionalità interattiva disponibile nello Stage (`index.html` / `src/player/runtime.ts`) **deve** essere disponibile e funzionare passo-passo anche nella Presenter View (`src/player/presenter.ts`), mantenendo lo stato sincronizzato in tempo reale tramite `SyncBus`:
  - Navigazione completa per slide e per **tutti** gli step progressivi (`0..maxStep`, senza saltare step intermedi).
  - Selettore lingua (`-lang_...` e `<switch systemLanguage>`).
  - Selettori di gruppi radio / temi (`-g_<group>`).
  - Toggle dei layer con scorciatoia (`-s_...`) e supporto alle relative scorciatoie da tastiera.
  - Sincronizzazione bidirezionale dello stato (`state`, `nav`, `set-language`, `set-group`, `toggle-filter`, `laser`).

## 2. Build & Verifica Obbligatori
- Dopo ogni modifica ai file in `src/core/`, `src/player/` o `src/build/`:
  1. Eseguire `npm test` (`node --test tests/core.test.ts`).
  2. Rigenerare `index.html` e `demo-deck/index.html` tramite `npm run build:index`.
  3. Rigenerare `dist/presentation.html` tramite `node cli.ts build demo-deck --out dist/presentation.html`.
- Per operazioni Git utilizzare sempre `gemgit` (mai `git`).
