import asyncio, sys, os, zipfile, io
from playwright.async_api import async_playwright
from pypdf import PdfReader

from paths import APP, FIX, OUT, LAUNCH
T = str(FIX); OUT = str(OUT)
errors = []

async def page_box(page, idx):
    return await page.locator(".page-wrap").nth(idx).bounding_box()

async def drag(page, x1, y1, x2, y2, steps=8):
    await page.mouse.move(x1, y1); await page.mouse.down()
    await page.mouse.move(x2, y2, steps=steps); await page.mouse.up()

async def ann_count(page):
    return await page.evaluate("window.__pdfEditor.store.pages.reduce((n,p)=>n+p.annotations.length,0)")

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**LAUNCH)
        ctx = await b.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True)
        page = await ctx.new_page()
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        await page.goto(APP)
        await page.screenshot(path=f"{OUT}/01-empty.png")

        # Open
        async with page.expect_file_chooser() as fc:
            await page.get_by_role("button", name="Open PDF").click()
        await (await fc.value).set_files(f"{T}/sample.pdf")
        await page.wait_for_function("window.__pdfEditor.store.pages.length === 3")
        await page.wait_for_timeout(800)
        await page.screenshot(path=f"{OUT}/02-open.png")

        bx = await page_box(page, 0)
        # Text
        await page.keyboard.press("t")
        await page.mouse.click(bx["x"] + 300, bx["y"] + 200)
        await page.keyboard.type("Hello World")
        await page.keyboard.press("Enter")
        await page.keyboard.type("Second line")
        await page.keyboard.press("Escape")
        assert await ann_count(page) == 1, "text not added"
        # Highlight
        await page.keyboard.press("h")
        await drag(page, bx["x"] + 70, bx["y"] + 175, bx["x"] + 400, bx["y"] + 195)
        # Pen
        await page.keyboard.press("p")
        await drag(page, bx["x"] + 100, bx["y"] + 500, bx["x"] + 300, bx["y"] + 560, 20)
        # Rect / ellipse / arrow / whiteout
        await page.keyboard.press("r"); await drag(page, bx["x"] + 420, bx["y"] + 450, bx["x"] + 560, bx["y"] + 540)
        await page.keyboard.press("e"); await drag(page, bx["x"] + 420, bx["y"] + 560, bx["x"] + 560, bx["y"] + 640)
        await page.keyboard.press("a"); await drag(page, bx["x"] + 100, bx["y"] + 650, bx["x"] + 300, bx["y"] + 700)
        await page.keyboard.press("w"); await drag(page, bx["x"] + 60, bx["y"] + 260, bx["x"] + 300, bx["y"] + 285)
        n = await ann_count(page); assert n == 7, f"expected 7 annotations, got {n}"
        # Select + move text
        await page.keyboard.press("v")
        txt = page.locator(".ann-text").first
        tb = await txt.bounding_box()
        await drag(page, tb["x"] + 10, tb["y"] + 5, tb["x"] + 60, tb["y"] + 45)
        moved = await page.evaluate("window.__pdfEditor.store.pages[0].annotations[0]")
        print("text after move:", {k: moved[k] for k in ("x", "y", "w", "h", "text")})
        print("ctx:", await page.locator(".ctx-label").text_content(), await page.evaluate("window.__pdfEditor.viewer.selectedId"), await page.evaluate("window.__pdfEditor.viewer.tool"))
        await page.screenshot(path=f"{OUT}/02b.png")
        # Change colour + size of the selected text via toolbar
        await page.locator(".propbar .tiny-num").fill("20"); await page.locator(".propbar .tiny-num").press("Enter")
        await page.locator('.swatch[title="#dc2626"]').first.click()
        t0 = await page.evaluate("window.__pdfEditor.store.pages[0].annotations[0]")
        assert t0["size"] == 20 and t0["color"] == "#dc2626", t0
        # Undo/redo
        await page.keyboard.press("Control+z"); await page.keyboard.press("Control+z")
        t1 = await page.evaluate("window.__pdfEditor.store.pages[0].annotations[0]")
        assert t1["size"] == 14, t1
        await page.keyboard.press("Control+y"); await page.keyboard.press("Control+y")
        # Edit existing text with double-click
        tb = await page.locator(".ann-text").first.bounding_box()
        await page.mouse.dblclick(tb["x"] + 10, tb["y"] + 8)
        await page.keyboard.press("End"); await page.keyboard.type("!!")
        await page.keyboard.press("Escape")
        t2 = await page.evaluate("window.__pdfEditor.store.pages[0].annotations[0].text")
        assert "!!" in t2, t2
        await page.screenshot(path=f"{OUT}/03-annotated.png")

        # Image
        async with page.expect_file_chooser() as fc:
            await page.get_by_role("button", name="Insert image").click()
        await (await fc.value).set_files(f"{T}/logo.png")
        await page.wait_for_timeout(300)
        # Signature (type)
        await page.get_by_role("button", name="Add signature").click()
        await page.get_by_role("tab", name="Type").click()
        await page.get_by_placeholder("Type your name").fill("Waqas Ahmad")
        await page.get_by_role("button", name="Place signature").click()
        await page.wait_for_timeout(300)
        # resize the signature via handle
        h = await page.locator(".sel-handle").bounding_box()
        await drag(page, h["x"] + 4, h["y"] + 4, h["x"] + 60, h["y"] + 30)
        assert await ann_count(page) == 9

        # Page tools: rotate page 2, delete page 3, add blank after page 1
        await page.locator(".thumb").nth(1).click()
        await page.get_by_role("button", name="Rotate page 2").click()
        await page.get_by_role("button", name="Delete page 3").click()
        await page.locator(".thumb").nth(0).click()
        await page.get_by_role("button", name="Add blank page after current").click()
        # Annotate blank page (now page 2)
        await page.locator(".thumb").nth(1).click(); await page.wait_for_timeout(300)
        bb = await page_box(page, 1)
        await page.keyboard.press("t"); await page.mouse.click(bb["x"] + 100, bb["y"] + 120)
        await page.keyboard.type("Notes on a blank page"); await page.keyboard.press("Escape")
        # Annotate rotated page (page 3) to test coordinates
        await page.locator(".thumb").nth(2).click(); await page.wait_for_timeout(400)
        rb = await page_box(page, 2)
        print("rb", rb, await page.evaluate(f"document.elementFromPoint({rb['x']+40},{rb['y']+40})?.outerHTML.slice(0,60)"))
        await page.keyboard.press("r"); await drag(page, rb["x"] + 40, rb["y"] + 40, rb["x"] + 200, rb["y"] + 100)
        print("counts", await page.evaluate("window.__pdfEditor.store.pages.map(p=>p.annotations.length)"), await page.evaluate("window.__pdfEditor.viewer.tool"))
        await page.keyboard.press("v")
        await page.screenshot(path=f"{OUT}/04-rotated.png")
        # Drag thumbnail 3 to first position
        await page.locator(".thumb").nth(2).drag_to(page.locator(".thumb").nth(0), target_position={"x": 40, "y": 5})
        order = await page.evaluate("window.__pdfEditor.store.pages.map(p=>[p.sourceId?p.sourceIndex+1:'blank', p.rotation])")
        print("page order after drag:", order)

        # Save
        async with page.expect_download() as dl:
            await page.get_by_role("button", name="Download").click()
        d = await dl.value; path = f"{OUT}/{d.suggested_filename}"; await d.save_as(path)
        print("saved", path)
        r = PdfReader(path)
        print("pages:", len(r.pages), "rotations:", [pg.get("/Rotate", 0) for pg in r.pages])
        print("text p(Hello):", [i for i, pg in enumerate(r.pages) if "Hello World" in (pg.extract_text() or "")])

        # Split: "1, 2-3"
        await page.locator(".side-actions button[title^='Split']").click()
        await page.locator("input[aria-label=\"Page ranges\"]").fill("1, 2-3")
        async with page.expect_download() as dl:
            await page.get_by_role("button", name="Split and download").click()
        d = await dl.value; zp = f"{OUT}/{d.suggested_filename}"; await d.save_as(zp)
        with zipfile.ZipFile(zp) as z:
            print("zip:", [(n, len(PdfReader(io.BytesIO(z.read(n))).pages)) for n in z.namelist()])

        # Merge: current + other.pdf + rotated.pdf
        await page.locator(".side-actions button[title='Merge PDFs']").click()
        async with page.expect_file_chooser() as fc:
            await page.get_by_role("button", name="Add PDFs…").click()
        await (await fc.value).set_files([f"{T}/other.pdf", f"{T}/rotated.pdf"])
        await page.get_by_role("button", name="Merge", exact=True).click()
        await page.wait_for_function("window.__pdfEditor.store.pages.length === 7")
        await page.wait_for_timeout(600)
        await page.screenshot(path=f"{OUT}/05-merged.png")
        # annotate base-rotated page (last page) then export
        await page.locator(".thumb").nth(6).click(); await page.wait_for_timeout(500)
        lb = await page_box(page, 6)
        await page.keyboard.press("t"); await page.mouse.click(lb["x"] + 60, lb["y"] + 60)
        await page.keyboard.type("On rotated"); await page.keyboard.press("Escape")
        await page.screenshot(path=f"{OUT}/06-baserot.png")
        async with page.expect_download() as dl:
            await page.get_by_role("button", name="Download").click()
        d = await dl.value; mp = f"{OUT}/merged-out.pdf"; await d.save_as(mp)
        r = PdfReader(mp); print("merged pages:", len(r.pages), [pg.get("/Rotate", 0) for pg in r.pages])

        # Encrypted file
        async with page.expect_file_chooser() as fc:
            await page.locator(".topbar .btn", has_text="Open").click()
        await (await fc.value).set_files(f"{T}/locked.pdf")
        await page.get_by_placeholder("Password").fill("secret")
        await page.locator(".modal .btn.primary").click()
        await page.wait_for_function("window.__pdfEditor.store.pages.length === 3")
        await page.wait_for_timeout(500)
        bx = await page_box(page, 0)
        await page.keyboard.press("t"); await page.mouse.click(bx["x"] + 300, bx["y"] + 300)
        await page.keyboard.type("Unlocked edit"); await page.keyboard.press("Escape")
        async with page.expect_download() as dl:
            await page.get_by_role("button", name="Download").click()
        d = await dl.value; ep = f"{OUT}/locked-out.pdf"; await d.save_as(ep)
        r = PdfReader(ep); print("locked out pages:", len(r.pages), "encrypted:", r.is_encrypted)

        print("console errors:", errors)
        await b.close()

asyncio.run(main())
