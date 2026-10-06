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

1. Enter the keypad's IP address, or click **Find** to discover it, and click
   **Load**. The designer saves a copy of the current design in
   `designer/backups/`.
1. Click a button on the keypad view. The editor shows its current images.
1. Add layers with **Shape**, **Icon**, **Text**, and **Image**. To move a
   layer, drag it on either canvas or change **X** and **Y**. To check the ON
   images on every button, select **Show ON state**.
1. Repeat for other buttons and pages. A dot marks each changed button.
1. Click **Deploy**. The keypad restarts with the new design in about 20
   seconds.

Every deploy saves the design that was running as
`designer/backups/backup_<date>_<time>.cpio`, and every **Load** saves a copy
as `loaded_<date>_<time>.cpio`. If a deploy fails, the designer selects the
backup it made. To put a design back, choose it in the list next to
**Restore backup**, and click **Restore backup**. Restoring works even when
the keypad has no design loaded.

If someone deployed to the keypad after you clicked **Load**, the designer
asks before it replaces their design.

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

Page changes count toward **Deploy**, and go to the keypad with your image
changes.

**Note:** HControl paths use page numbers, such as `/page3/button1/action`.
Adding a page only adds new numbers. Deleting a page moves the pages after it
up one number, so update any app that uses their paths.

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

1. Load the design, and check that the keypad view matches the keypad's
   screen: the same images in the same positions, on the same page.
1. Edit button 1 with a shape, an icon, and text, and button 2 with an image.
1. Deploy, and check both buttons on the keypad in both states. To switch a
   button to ON, run `python 01_buttons_dial_feedback.py` and press it.
1. Click **Load** again, and check that the designer shows the deployed images.
1. Restore the backup, and check that the keypad shows the original design.
