# svg-deck

Compilatore CLI standalone e zero-dependency scritto in Rust che trasforma uno o più file `.svg` e/o cartelle in una **singola presentazione `.html` autonoma e offline-ready**, completa di runtime interattivo, Presenter View sincronizzata, animazioni SMIL native, traduzioni multilingua e supporto per l'export PDF.

> Per agenti AI / LLM: vedi il riferimento compatto [llms.txt](llms.txt).

---

## Indice

1. [Installazione e Build](#installazione-e-build)
2. [Utilizzo da Riga di Comando (CLI)](#utilizzo-da-riga-di-comando-cli)
3. [Strategia di Risoluzione a 3 Livelli (Tier 1, 2, 3)](#strategia-di-risoluzione-a-3-livelli-tier-1-2-3)
4. [Grammatica dei Nomi File e dei Livelli `<g>`](#grammatica-dei-nomi-file-e-dei-livelli-g)
5. [Sanitizzazione Non Distruttiva e Placeholder](#sanitizzazione-non-distruttiva-e-placeholder)
6. [Traduzioni Multilingua Dual-Mode](#traduzioni-multilingua-dual-mode)
7. [Animazioni SMIL Native e Step Progressivi](#animazioni-smil-native-e-step-progressivi)
8. [Note del Relatore (Speaker Notes)](#note-del-relatore-speaker-notes)
9. [Player Interattivo, Parametri URL e Presenter View](#player-interattivo-parametri-url-e-presenter-view)
10. [Embedding dei Font (`--embed-fonts`) ed Export PDF (`--pdf`)](#embedding-dei-font---embed-fonts-ed-export-pdf---pdf)
11. [Deck di Esempio e Test](#deck-di-esempio-e-test)

---

## Installazione e Build

### Prerequisiti
- Toolchain Rust (`rustc` / `cargo` >= 1.85, edizione 2024).
- *(Opzionale)* Chromium, Google Chrome, Brave o Microsoft Edge per l'export `--pdf`.

### Compilazione

```bash
# Esegui i test unitari e di integrazione
cargo test

# Compila il binario release ottimizzato (LTO, stripped)
cargo build --release
```

Il binario risultante si trova in `target/release/svg-deck`.

---

## Utilizzo da Riga di Comando (CLI)

`svg-deck` accetta combinazioni arbitrarie di file singoli (`--file`), cartelle (`--folder`) e argomenti posizionali, **preservando l'ordine esatto passato da riga di comando**. I file all'interno di una cartella vengono ordinati in modo naturale/alfanumerico (es. `2-...` prima di `10-...`) e deduplicati per percorso canonico mantenendo la prima occorrenza.

```bash
# Compila una cartella (default: output presentation.html)
svg-deck --folder ./demo-deck -o dist/presentation.html

# Combina file singoli e più cartelle in ordine CLI esatto
svg-deck \
  --folder ./test-suite-deck/overlays \
  --folder ./test-suite-deck/slides \
  --file ./test-suite-deck/single_master.svg \
  --file ./test-suite-deck/standalone_chart.svg \
  --folder ./test-suite-deck/extras \
  -o dist/test-suite-presentation.html

# Argomenti posizionali misti
svg-deck master.svg ./extra_slides -o presentation.html
```

### Opzioni CLI

| Flag | Descrizione | Default |
| :--- | :--- | :--- |
| `--file <PATH>` | Aggiunge un file `.svg` (ripetibile). Cerca anche eventuali sidecar `<nome>.md`/`.txt` adiacenti. | — |
| `--folder <DIR>` | Aggiunge tutti i `.svg`, `.md` e `.txt` della cartella in ordine naturale (ripetibile). | `.` (se nessun input) |
| `<INPUTS>...` | File o cartelle posizionali (mischabili con `--file` e `--folder`). | — |
| `-o, --output <PATH>` | Percorso del file HTML di output. | `presentation.html` |
| `--watch` | Monitora tutti i file/cartelle di input e la cartella `fonts/` ricompilando automaticamente al salvataggio. | `false` |
| `--embed-fonts` | Cerca i `font-family` usati negli SVG dentro `./fonts` e nelle cartelle di sistema e li incorpora come `@font-face` Base64. | `false` |
| `--pdf` | Esporta ogni slide e ogni step progressivo in un PDF multipagina tramite browser headless. | `false` |
| `--lang <CODE>` | Lingua iniziale del player / lingua usata per l'export PDF (es. `en`, `it`). | Prima lingua rilevata |
| `--filters <LIST>` | Lista separata da virgole di filtri/gruppi da attivare all'avvio o nell'export PDF. | — |

---

## Strategia di Risoluzione a 3 Livelli (Tier 1, 2, 3)

Per ogni file `.svg` incontrato nell'ordine CLI, `svg-deck` applica una cascata deterministica a 3 livelli:

1. **Tier 1 — Match sulla grammatica del nome file:**
   - Se il nome file contiene un prefisso `<selector>-` (es. `1-cover.svg`, `!1-footer-overlay_1.svg`) oppure almeno un token opzione riconosciuto (`-underlay`, `-overlay`, `-step_...`, `-t_...`, `-g_...`, `-lang_...`, `-default`, `-s_...`), il file viene trattato come layer con quelle regole.
   - Se al suo interno contiene anche dei `<g>` con `inkscape:label` o `id` che usano la grammatica (es. `step_1`, `lang_it`, `-s_ctrl_m`), tali `<g>` **ereditano** il selettore e le regole del file unendole alle proprie.
2. **Tier 2 — Match sui livelli `<g>` interni (file non strutturato):**
   - Se il nome file non segue la grammatica (es. `single_master.svg` o `deck.svg`), il compilatore ispeziona i `<g>` interni (priorità a `inkscape:label`, fallback su `id`).
   - Ogni `<g>` che corrisponde alla grammatica (`slide_3`, `slide_3-step_1`, `bg-underlay_2`, `4-callout-s_alt_n`, ecc.) viene schedulato nella timeline unificata della presentazione.
3. **Tier 3 — Fallback sequenziale automatico:**
   - Se né il nome file né alcun `<g>` interno usa la grammatica (es. `standalone_chart.svg`, `extra_diagram.svg`), l'intero SVG viene assegnato automaticamente alla **slide sequenziale successiva** (`current_max_slide + 1`) nell'ordine di apparizione da CLI.

Tutti e tre i Tier possono convivere liberamente nella stessa compilazione.

---

## Grammatica dei Nomi File e dei Livelli `<g>`

Sintassi completa dei token separati da `-` (nei titoli, `_` viene convertito in spazio):

```text
[<selector>-]<title>[-underlay[_<z>]|-overlay[_<z>]][-step_<k>][-t_<trans>][-g_<group>][-lang_<codes>][-default][-s_<keys>...].svg
```

Nei livelli `<g>` interni (`inkscape:label` o `id`), è inoltre supportato il prefisso `slide_<selector>` (es. `slide_3`, `slide_3-step_1`, `slide_1_4,!2`).

### Token supportati

- **`<selector>`** *(opzionale)* — Regola: `^!?(\d+(_\d+)?)(,!?(\d+(_\d+)?))*$`
  - `1-intro.svg`: solo slide `1`.
  - `1_5-chapter.svg`: intervallo inclusivo da `1` a `5`.
  - `1,3,5_8-diagram.svg`: slide `1`, `3` e `5..8`.
  - `!1,!10-footer-overlay.svg`: tutte le slide **tranne** `1` e `10`.
  - `1_5,!3-badge-overlay.svg`: da `1` a `5` **esclusa** la `3`.
  - *(Omesso)*: layer globale su tutte le slide (`1..totalSlides`).
- **`<title>`**: titolo mostrato nella UI e iniettato in `{{TITLE}}` (`_` → spazio).
- **Banda e Z-Index**:
  - `-underlay` / `-underlay_<z>`: sotto le slide normali (`z = -1000 + z`, default `0`). Sfondo root `<svg>` forzato trasparente.
  - *(Nessun token banda)*: livello normale (`z = 0`).
  - `-overlay` / `-overlay_<z>`: sopra le slide normali (`z = 1000 + z`, default `0`). Sfondo root `<svg>` forzato trasparente.
- **`-step_<k>`**: step progressivo (`k >= 0`, default `0`). I layer con `step > 0` appaiono in sequenza alla pressione di `Next` prima di passare alla slide successiva.
- **`-t_<effect>`**: transizione della slide (`fade` default, `slide`, `zoom`, `none`).
- **`-g_<group>`** e **`-default`**: gruppo radio mutuamente esclusivo (es. `-g_palette`). Se un'opzione ha `-default` parte attiva; altrimenti parte attiva la prima del gruppo.
- **`-lang_<code1>[_<code2>...]`**: associa il layer a uno o più codici lingua ISO (es. `-lang_en`, `-lang_it_en`).
- **`-s_<mod>_<key>`** *(ripetibile)*: scorciatoia da tastiera (es. `-s_ctrl_alt_z`, `-s_alt_n`, `-s_ctrl_win_z`). I layer con `-s_...` (e senza `-default`) partono nascosti e aggiungono un pulsante toggle nell'HUD, nell'Home Launcher e nella Presenter View.
- **Proporzioni e Dimensionamento (`-unboxed` / `-sized`)**:
  - *(Default — boxed)*: tutti i componenti e le slide convertono le eventuali unità fisiche (`mm`, `cm`, `in`, `pt`, `pc`, `px`) nelle coordinate del `viewBox` (sintetizzato se mancante) e mantengono le proporzioni originali (`preserveAspectRatio="xMidYMid meet"`), scalando proporzionalmente allo schermo (es. un 16:9 rimane 16:9).
  - **`-unboxed`** *(su file o `<g>`)*: disattiva il vincolo delle proporzioni adattando il layer a larghezza e altezza dello schermo (`preserveAspectRatio="none"`).
  - **`-sized`** *(su file o `<g>`)*: mantiene le esatte dimensioni originali (`px`, `mm`, `cm`, ecc.) dell'elemento e dei suoi figli senza che il compilatore le modifichi (`data-sized="1"`).

---

## Sanitizzazione Non Distruttiva e Placeholder

- **Integrità dei `<g>` e del DOM SVG:** i `<g>` gestiti **non vengono mai staccati** dal loro `<svg>` padre. Restano intatti `<defs>`, `<style>`, `viewBox` e tutta la catena di `transform` degli antenati.
- **Reset della visibilità dell'editor:** eventuali `display="none"`, `visibility="hidden"`, `opacity="0"` (e le rispettive proprietà in `style="..."`) salvati da Inkscape/Illustrator sui `<g>` gestiti vengono rimossi a compilazione e sostituiti da attributi `data-*` (`data-slides`, `data-step`, `data-lang`, `data-filter`, `data-group`, `data-default`, `data-band`).
- **Clonazione multi-banda / multi-slide:** se un singolo SVG master contiene `<g>` su bande z o slide diverse, l'intero `<svg>` viene clonato per slot con prefissi ID univoci (`f{file}_s{slide}_b{slot}_`), nascondendo con `style="display: none"` i rami `<g>` non pertinenti a quello slot (preservando però eventuali `<g>` antenati che contengono figli attivi).
- **Namespacing ID e SMIL:** tutti gli `id="..."`, `url(#...)`, `href="#..."`, `xlink:href="#..."` e i riferimenti SMIL `begin="..."` / `end="..."` (es. `begin="c1.end+0.15s"`) vengono prefissati per evitare collisioni nel DOM.
- **Normalizzazione Root `<svg>`:** rimozione di prologo XML, `<!DOCTYPE ...>` e `width`/`height` fissi (preservando o sintetizzando `viewBox`).
- **Placeholder dinamici:**
  - `{{INDEX}}`: numero della slide corrente (1-based).
  - `{{TOTAL}}`: numero totale di slide.
  - `{{TITLE}}`: titolo della slide corrente (XML-escaped).
  - `{{PROGRESS}}`: percentuale intera `0`–`100`.
  - `{{DATE}}`: data di compilazione ISO (`YYYY-MM-DD`).

---

## Traduzioni Multilingua Dual-Mode

`svg-deck` supporta due modalità combinabili nella stessa presentazione:
1. **Livelli file o `<g>` con `-lang_<code>`** (es. `3-bilingual_en-lang_en.svg` / `base_it-lang_it`).
2. **Blocchi SVG nativi `<switch>` con `systemLanguage`** (più un figlio senza `systemLanguage` come fallback):
   ```xml
   <switch>
     <text systemLanguage="en">Hello</text>
     <text systemLanguage="it">Ciao</text>
     <text>Fallback</text>
   </switch>
   ```
   In fase di compilazione `systemLanguage` viene convertito in `data-system-language` così il player può cambiare lingua dinamicamente indipendentemente da `navigator.language`.

Tutte le lingue trovate vengono rilevate automaticamente per popolare i selettori di lingua.

---

## Animazioni SMIL Native e Step Progressivi

- Gli `<svg>` delle slide inattive vengono messi in pausa (`pauseAnimations()`).
- All'ingresso su una slide (o su un layer singolo per step), la timeline riparte da `0` (`setCurrentTime(0); unpauseAnimations()`).
- Quando si avanza a uno **step > 0** dentro un `<svg>` multi-layer già attivo allo step 0, il player **non** resetta le animazioni dello step 0, ma avvia gli elementi SMIL (`<animate>`, `<animateTransform>`, `<animateMotion>`, `<set>`) presenti dentro il `<g data-step="<k>">` appena rivelato chiamando `.beginElement()`.

---

## Note del Relatore (Speaker Notes)

Le note per la Presenter View vengono raccolte automaticamente da:
1. **File sidecar `.md` / `.txt`** con prefisso selettore (es. `2-nested_mix.md`, `2-architecture.md`).
2. **Tag `<desc>`** dentro gli SVG: nei file multi-layer i `<desc>` dentro un `<g>` gestito vengono associati **solo** alle slide di quel `<g>`, mentre i `<desc>` di root vengono inclusi globalmente per quel file.

---

## Player Interattivo, Parametri URL e Presenter View

### Comportamento iniziale (`home=1` opt-in)
- Aprendo `presentation.html` normalmente, la presentazione **inizia direttamente dalla Slide 1, Step 0**.
- Per aprire l'**Home Launcher (Slide 0)** all'avvio, aggiungere `?home=1` nell'URL (oppure premere `Home` / `0` / cliccare `⌂` nella barra HUD).

### Parametri URL supportati
- `?home=1`: apre direttamente sull'Home Launcher (Slide 0).
- `?language=<code>`: imposta la lingua iniziale (es. `?language=it`).
- `?slide=<n>&step=<k>`: apre direttamente alla slide `n` e step `k`.
- `?presenter=1`: apre in modalità Presenter View.

### Scorciatoie da tastiera

| Tasto | Azione |
| :--- | :--- |
| `→`, `Space`, `PageDown`, Click | Step successivo o Slide successiva |
| `←`, `PageUp` | Step precedente o Slide precedente |
| `P` | Apre la **Presenter View** sincronizzata (`BroadcastChannel` + `localStorage` fallback) |
| `G` o `Esc` | Apre/chiude la **Griglia Panoramica** (Overview Grid) |
| Tieni premuto `L` | **Puntatore Laser** virtuale (sincronizzato con la Presenter View) |
| `D` / `C` | Attiva/disattiva **Disegno a mano libera** / Cancella tratti |
| `H` | Mostra/nasconde la barra **HUD** |
| `F` | Attiva/disattiva **Fullscreen** |
| `Home` / `0` | Torna all'Home Launcher (Slide 0) |

La **Presenter View** include anteprima slide corrente, anteprima slide/step successivo, note del relatore, timer presentazione (Pause/Reset) + ora corrente, controlli sincronizzati per **lingua**, **gruppi/temi**, **toggle shortcut** e supporto alle scorciatoie da tastiera.

---

## Embedding dei Font (`--embed-fonts`) ed Export PDF (`--pdf`)

- Con `--embed-fonts`, `svg-deck` scansiona tutti i `font-family` dichiarati negli SVG (ignorando le famiglie generiche CSS) e cerca i font corrispondenti in `./fonts` (relativo agli input o alla CWD) e nelle directory di sistema (`/usr/share/fonts`, `/usr/local/share/fonts`, `~/.local/share/fonts`, `/Library/Fonts`, ecc.).
- **Priorità dei formati:** `.woff2` → `.woff` → `.ttf` → `.otf`.
- Se un font incorporato supera **500 KB**, viene emesso un avviso su stderr suggerendo di usare un `.woff2` o un font subsettato.
- Con `--pdf`, `svg-deck` cerca `CHROME_PATH` o un browser headless (`chromium`, `google-chrome`, `brave-browser`, `microsoft-edge`) ed esporta ogni `(slide, step)` in un PDF multipagina 1280×720 rispettando `--lang` e `--filters`.

---

## Deck di Esempio e Test

- **[demo-deck/](demo-deck/)**: deck compatto da 3 slide bilingue (`en`/`it`) con `underlay`, `overlay`, step progressivi (`0..2`), gruppo radio tema globale, toggle shortcut (`Ctrl+Alt+Z`), SMIL concatenato e note `.md` + `<desc>`.
- **[test-suite-deck/](test-suite-deck/)**: suite completa a 6 slide bilingue (`en`/`it`) che combina più `--folder` (`overlays/`, `slides/`, `extras/`) e più `--file` (`single_master.svg` Tier 2, `standalone_chart.svg` Tier 3) testando tutti e 3 i Tier e i `<g>` annidati.

```bash
# Compila la test-suite completa
./target/release/svg-deck \
  --folder test-suite-deck/overlays \
  --folder test-suite-deck/slides \
  --file test-suite-deck/single_master.svg \
  --file test-suite-deck/standalone_chart.svg \
  --folder test-suite-deck/extras \
  -o dist/test-suite-presentation.html
```

---

## GitHub Releases

Il workflow [.github/workflows/release.yml](.github/workflows/release.yml) si avvia automaticamente quando viene pubblicata una Release su GitHub (`release: types: [published]`) ed è vincolato a girare **solo su GitHub** (`if: github.server_url == 'https://github.com'`), restando inattivo su Forgejo.

Creando una Release da GitHub, il workflow compila e allega alla release i binari con relativi checksum `.sha256` per:
- **Linux:** `x86_64-unknown-linux-gnu` (x64), `i686-unknown-linux-gnu` (x86), `aarch64-unknown-linux-gnu` (arm64), `armv7-unknown-linux-gnueabihf` (arm32)
- **Windows:** `x86_64-pc-windows-msvc` (x64), `i686-pc-windows-msvc` (x86), `aarch64-pc-windows-msvc` (arm64)
- **macOS:** `x86_64-apple-darwin` (x64), `aarch64-apple-darwin` (arm64)
