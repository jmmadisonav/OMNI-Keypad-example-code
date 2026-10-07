# Button designer

The button designer is a local web page where you design button images for
an OMNI keypad and deploy them to it. Each button gets an OFF and an ON image,
built from layers. The images are 188x188 pixels on the 8BV and 150x150 on the
6B and 6BV; the designer renders them at the project's size, so you lay out
layers the same way on every model.

The layers are:

- **Shape:** a base shape from `docs/Keypad Graphics.zip` (Squared, Bubble, or
  Circle 45) in any of its colours.
- **Icon:** any of more than 1,800 Lucide icons, with separate OFF and ON
  colours.
- **Text:** one or two lines in Titillium Web, Inter, Roboto, or Oswald.
- **Image:** a PNG or SVG of your own, such as a logo.

The designer runs on your computer and doesn't need internet access.

## Before you begin

You need Python 3.10 or later, and a keypad that runs firmware 1.1.x on your
network. Deploying uploads the whole design, so it uses the same experimental
method as Part 3 in the main README.

## Start the designer

To start the designer, run this command from the repository folder:

```
python designer/server.py
```

The designer opens in your browser at `http://127.0.0.1:8044/`. To use another
port, add `--port 8050`. To stop it, press Ctrl+C.

The designer is also a Windows desktop app, **OMNI Keypad Designer**, with its
own installer. The app carries its own Python, so you don't need to install
Python to use it. It keeps projects, backups, and the recipe library in
`Documents\OMNI Keypad Designer` instead of `designer/`. To open that folder,
click **File > Open Projects Folder**. To build the app, see
[Build the desktop app](#build-the-desktop-app).

## Design and deploy buttons

1. The designer opens your most recent project, or a new project called
   "Untitled" the first time. To start another, click **New**, and choose its
   name and keypad model. To work on a keypad's current design, enter its IP
   address, or click **Find**, and click **Load**. That saves the design as a
   new project named after the keypad, for example `172-17-0-55 2026-10-06`.
1. Click a key on the keypad view. The **Button** tab shows its OFF and ON
   canvases and its layers. A button that wasn't made in the designer opens
   as one Image layer that holds its existing artwork.
1. Add layers with **+ Shape**, **+ Icon**, **+ Text**, and **+ Image**, or
   click **Quick button** to build a shape, an icon, and a label in one step.
   To move a layer, drag it on either canvas or change **X** and **Y**. To
   check the ON images on every key, click **ON** under the keypad view.

   A shape uses a colour from Keypad Graphics. To use your own OFF and ON
   colours instead, click **+** after the colour swatches. The designer
   recolours the set's grey artwork, so the shape keeps its shading.
1. Repeat for other keys and pages. A red square marks each changed key, and
   one next to the project name means there are unsaved changes.
1. Click **Save**. You don't need a keypad for any of these steps.
1. To put the project on a keypad, enter its IP address and click **Deploy**.
   The designer saves first if needed. The keypad restarts with the project
   in about 20 seconds.

To undo a change, press Ctrl+Z. To redo it, press Ctrl+Y or Ctrl+Shift+Z. You
can undo every change since you last saved or opened the project. In a text
field, Ctrl+Z undoes your typing in that field instead.

To swap two keys, drag one onto the other. The artwork, the button name, and
the page link move. The control settings, such as the HControl path, stay with
each slot.

### Backups

Every deploy saves the design that was running as
`designer/backups/backup_<date>_<time>.cpio`, every **Load** saves a copy as
`loaded_<date>_<time>.cpio`, and **Back up keypad now** in **Backups** saves
`manual_<date>_<time>.cpio`. If a deploy fails after its backup, the designer
offers to restore that backup.

To put a design back, click **Backups**, choose a backup, and click
**Restore**. Restoring works even when the keypad has no design loaded.

A keypad with no design, for example after a factory reset, doesn't need a
backup: **Deploy** checks for a design for about 15 seconds, then uploads the
project anyway.

If the keypad has a different design from the one this project last loaded
from or deployed to, the designer asks before it replaces it.

## Add pages and switch between them

The page tabs above the keypad view show the design's pages. To change the
pages, use the tabs:

- To add a page, click **+ Page**. A new page has page 1's dial and LED ring
  settings and no button images. A design can have up to 9 pages.
- To rename a page, double-click its tab. Page names must be unique. Buttons
  that switch to the page keep switching to it.
- To delete the current page, click **×** on its tab. Buttons that switch to
  it stop switching pages.

To show another page while you drag a key, drag it over that page's tab.

To make a button switch pages, select the button, and then choose a page in
**Go to page**. The keypad switches pages by itself, without any app running.
A badge such as **→ Lights** marks each button that switches pages.

Page changes are saved with the project, and go to the keypad when you
deploy it.

**Note:** HControl paths use page numbers, such as `/page3/button1/action`.
Adding a page only adds new numbers. Deleting a page moves the pages after it
up one number, so update any app that uses their paths.

## Keypad models

The designer supports these OMNI keypads:

| Model | Buttons | Dial and LED ring |
|---|---|---|
| OMNI-KP-6B | 6, in 2 columns and 3 rows | No |
| OMNI-KP-6BV | 6, in 2 columns and 3 rows | Yes |
| OMNI-KP-8BV | 8, in 4 columns and 2 rows | Yes |

Each project is for one model. To choose it, click **New** and pick the
model. **Load** uses the model the keypad reports. You can't change a
project's model later. The model appears next to the project name.

If a project's model file is missing, the designer shows an error. You can
still edit the project, but you can't deploy it until you put the model file
back.

The 6B and 6BV are marked "untested": their templates follow AVX
Architect's 6B and 6BV designs, but haven't been deployed to a real unit
yet.

**Deploy** checks the keypad's model first. If it isn't the project's model,
nothing is uploaded.

Each model is a file in `designer/models/`. If a real keypad's design differs
from a model's template, change the template in that file. The designer
checks the files when it starts, and names any file that's wrong.

## Projects

Each project is a folder in `designer/projects/`:

| File | Contains |
|---|---|
| `keypad.json` | The design, in the same format as the repo's `design/` folder |
| `images/` | The button images the design uses |
| `designer.json` | Each button's layers, which keypad design the project last matched, and when it was last deployed |

To open a project, choose it in **Open**. To keep a copy under another name,
click **Save as**. To delete a project, delete its folder.

Because a project folder is a complete design, you can also deploy it from
the command line, for example
`python 03_upload_design.py upload designer/projects/Lobby`.

## Reuse designs with the library

To keep a button's layers so you can change them later, click **Save to
library** and give it a name. Recipes are saved in `designer/library/`. To use
a recipe, open the **Library** tab, and then click the recipe to apply it to
the selected key, or drag it onto any key. Applying a recipe replaces the
key's layers and name, and keeps its page link.

The recipe name also names the image files on the keypad, for example
`HDMI_1_OFF.png`. Buttons that use the same recipe share the same files. To
change the file names for one button, edit its **Button name**.

**Ready-made** shows the finished buttons in `Keypad Graphics.zip`.

## Program the keypad from your own code

The **HControl** drawer under the keypad view shows the strings your own code
sends to the keypad and the replies to expect. To see them for a key, select
the key. The strings cover that key's page and button numbers: subscribing to
presses, getting and setting the feedback state, and enabling or disabling the
button. A key with a page link also shows how to follow page changes, and
models with a dial show the dial and LED ring paths. The **Notes** pane
explains the protocol rules.

- To copy one line, point to it and click the copy button.
- To copy every line, click **Copy all**. Each line starts with `->` for a
  line you send or `<-` for one you receive.
- To resize the drawer, drag its top edge. To hide or show it, click
  **HControl**.

If you've added or deleted pages since you last saved, the drawer warns you
that the page numbers can change when you save and deploy.

## Build the desktop app

The desktop app is an Electron window around the designer. It starts
`designer/server.py` with a bundled copy of Python's embeddable runtime,
and shows the same page you get in a browser. Its code is in `electron/`, and
its release scripts are in `build_tools/`, following the BSS Commission app.

### Before you begin

- Node.js 22 or later.
- The Node dependencies: run `npm install` from the repository folder.
- To sign a release: the code-signing certificate at
  `%OneDriveCommercial%\WindowSigningCert\MyKey.pfx`, and a `.env` file at the
  repository root with `SIGNING_PASSWORD` set to its password. To make one,
  copy `.env.example` to `.env`. `.env` is ignored by git; never commit it.

The first build downloads Python's embeddable runtime from python.org and
keeps it in `build/cache/`. To use another Python version, change
`PYTHON_VERSION` in `build_tools/stage-python.mjs`.

### Run and build

- To run the app from source, run `npm run electron`. It uses the Python on
  your PATH, or the one the `OMNI_PYTHON` environment variable names.
- To build the app without an installer, run `npm run package`. The app is
  in `output/win-unpacked/`.
- To build an unsigned installer, run `npm run installer`. The installer is
  `output/omni_keypad_designer_setup_v<version>.exe`.

To try a build without touching your own projects, set
`OMNI_KEYPAD_DATA_DIR` to another folder before you start the app.

### What the installer does

- Asks whether to install for everyone on the computer (needs admin) or just
  the current user, and lets you change the install folder.
- Adds a Start menu shortcut, **OMNI Keypad Designer**. There's no desktop
  shortcut.
- Offers to start the app when it finishes, and adds the app to Windows'
  installed apps, with an uninstaller.

### Licensing

The app is licensed like every Magic Software app: at startup it checks in
with the license server as `omni_keypad_designer`, and keeps its license in
`HKCU\SOFTWARE\Magic Software\OMNI Keypad Designer`. If the server requires a
serial number, the app asks for one, and it supports manual activation when
the server can't be reached. The server decides whether a serial is required;
to require one even before the server first answers, set `ENFORCE_SERIAL` in
`electron/main.ts`.

The check-in is also the update check: if the server reports a newer version,
the app offers to open its download page.

### Cut a release

To build a signed release, run:

```
npm run release -- <version>
```

For example, `npm run release -- 0.2.0`. The script bumps the version in
`package.json`, opens `output/release_notes.txt` for you to fill in, builds
and signs the app and its installer, and zips the installer with the release
notes as `output/OMNI_Keypad_Designer_<version>.zip`. To preview the steps
without changing anything, add `--dry-run`.

The release signs the app, its installer, and its uninstaller. The bundled
`python.exe` and `pythonw.exe` keep the Python Software Foundation's own
signature: `build_tools/sign.cjs` stops electron-builder from replacing it
with yours.

The script doesn't touch git. Afterwards, commit, tag, and push the release,
and then publish it to GitHub Releases:

```
git tag v<version>
git push origin v<version>
npm run release:publish -- <version>
```

Publishing needs the [GitHub CLI](https://cli.github.com/), signed in with
`gh auth login`.

## Run the tests

To run the Python tests, run `python -m unittest discover -s tests -t .`.

To run the JavaScript tests, you need Node.js 18 or later. Run
`npm run test:designer` for the designer page, and `npm test` for the desktop
app and its build scripts.

## Check on a real keypad

To check the designer against a keypad, do the following:

1. Load the design with **Load**, and check that the keypad view matches the keypad's
   screen: the same images in the same positions, on the same page.
1. Edit button 1 with a shape, an icon, and text, and button 2 with an image.
1. Deploy, and check both buttons on the keypad in both states. To switch a
   button to ON, run `python 01_buttons_dial_feedback.py` and press it.
1. Click **Load** again, and check that the designer shows the deployed images.
1. In **Backups**, restore the backup, and check that the keypad shows the original design.
