# Button designer

The button designer is a local web page where you design button images for
an OMNI keypad and deploy them to it. Each button gets an OFF and an ON image,
188x188 pixels, built from layers:

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

## Design and deploy buttons

1. The designer opens your most recent project, or a new project called
   "Untitled" the first time. To start another, click **New**, and choose its
   name and keypad model. To work on a keypad's current design, enter its IP
   address, or click **Find**, and click **Load from keypad**. That saves the
   design as a new project named after the keypad, for example
   `172-17-0-55 2026-10-06`.
1. Click a button on the keypad view. The editor shows its layers, or its
   current images if it wasn't designed in the designer.
1. Add layers with **Shape**, **Icon**, **Text**, and **Image**. To move a
   layer, drag it on either canvas or change **X** and **Y**. To check the ON
   images on every button, select **Show ON state**.
1. Repeat for other buttons and pages. A dot marks each changed button, and a
   dot next to the project name means there are unsaved changes.
1. Click **Save**. You don't need a keypad for any of these steps.
1. To put the project on a keypad, enter its IP address and click **Deploy**.
   The designer saves first if needed. The keypad restarts with the project
   in about 20 seconds.

Every deploy saves the design that was running as
`designer/backups/backup_<date>_<time>.cpio`, and every **Load from keypad**
saves a copy as `loaded_<date>_<time>.cpio`. If a deploy fails, the designer
selects the backup it made. To put a design back, choose it in the list next to
**Restore backup**, and click **Restore backup**. Restoring works even when
the keypad has no design loaded.

A keypad with no design, for example after a factory reset, doesn't need a
backup: **Deploy** checks for a design for about 15 seconds, then uploads the
project anyway.

If the keypad has a different design from the one this project last loaded
from or deployed to, the designer asks before it replaces it.

## Add pages and switch between them

The page tabs above the keypad view show the design's pages. To change them,
use the buttons next to the tabs:

- To add a page, click **+**. A new page has page 1's dial and LED ring
  settings and no button images. A design can have up to 9 pages.
- To rename the current page, click **Rename**. Buttons that switch to the
  page keep switching to it.
- To delete the current page, click **Delete**. Buttons that switch to it
  stop switching pages.

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
model. **Load from keypad** uses the model the keypad reports. You can't
change a project's model later.

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
| `designer.json` | Each button's layers, and which keypad design the project last matched |

To open a project, choose it in **Open…**. To keep a copy under another name,
click **Save as**. To delete a project, delete its folder.

Because a project folder is a complete design, you can also deploy it from
the command line, for example
`python 03_upload_design.py upload designer/projects/Lobby`.

## Reuse designs with the library

To keep a button's layers so you can change them later, click **Save to
library** and give it a name. Recipes are saved in `designer/library/`. To use
a recipe on another button, select the button and click the recipe.

The recipe name also names the image files on the keypad, for example
`HDMI_1_OFF.png`. Buttons that use the same recipe share the same files.

**Ready-made** shows the finished buttons in `Keypad Graphics.zip`.

## Run the tests

To run the Python tests, run `python -m unittest discover -s tests -t .`.

To run the JavaScript tests, you need Node.js 18 or later. Run
`node --test "designer/static/*.test.mjs"`.

## Check on a real keypad

To check the designer against a keypad, do the following:

1. Load the design with **Load from keypad**, and check that the keypad view matches the keypad's
   screen: the same images in the same positions, on the same page.
1. Edit button 1 with a shape, an icon, and text, and button 2 with an image.
1. Deploy, and check both buttons on the keypad in both states. To switch a
   button to ON, run `python 01_buttons_dial_feedback.py` and press it.
1. Click **Load from keypad** again, and check that the designer shows the deployed images.
1. Restore the backup, and check that the keypad shows the original design.
