import asyncio, json
from playwright.async_api import async_playwright
from paths import APP, FIX, OUT, LAUNCH
T = str(FIX); OUT = str(OUT)
errs = []
async def openfile(page, f, first=False):
    if first:
        async with page.expect_file_chooser() as fc: await page.get_by_role("button", name="Open PDF").click()
    else:
        async with page.expect_file_chooser() as fc: await page.locator(".topbar .btn", has_text="Open").click()
    await (await fc.value).set_files(f"{T}/{f}")
    if await page.locator(".modal .btn.danger").count(): await page.locator(".modal .btn.danger").click()
    await page.wait_for_function("window.__pdfEditor.store.pages.length > 0 && !document.querySelector('.busy')")
    await page.wait_for_timeout(700)
async def objs(page, i=0):
    return await page.evaluate(f"window.__pdfEditor.store.pages[{i}].objEdits || {{}}")
async def to_screen(page, x, y, i=0):
    # page point -> screen (unrotated pages only)
    b = await page.locator(".page-wrap").nth(i).bounding_box()
    z = await page.evaluate("window.__pdfEditor.viewer.zoom")
    return b["x"] + x * z, b["y"] + y * z
async def drag(page, x1, y1, x2, y2):
    await page.mouse.move(x1, y1); await page.mouse.down(); await page.mouse.move(x2, y2, steps=10); await page.mouse.up()
async def save(page, name):
    async with page.expect_download() as dl: await page.get_by_role("button", name="Download").click()
    d = await dl.value; await d.save_as(f"{OUT}/{name}"); return f"{OUT}/{name}"

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**LAUNCH); ctx = await b.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True)
        page = await ctx.new_page()
        page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errs.append(str(e)))
        await page.goto(APP)
        # ---------- LibreOffice / Word PDF ----------
        await openfile(page, "doc.pdf", first=True)
        await page.keyboard.press("x"); await page.wait_for_timeout(500)
        # select the title
        x, y = await to_screen(page, 100, 55); await page.mouse.move(x, y); await page.wait_for_timeout(200)
        await page.mouse.click(x, y); await page.wait_for_timeout(200)
        print("label:", await page.locator(".ctx-label").text_content())
        # change "Waqas Ahmad"
        x, y = await to_screen(page, 150, 90); await page.mouse.dblclick(x, y); await page.wait_for_timeout(300)
        print("editor value:", await page.locator(".obj-text-editor").input_value())
        await page.keyboard.press("Control+a"); await page.keyboard.type("Ali Raza"); await page.keyboard.press("Enter")
        # change the title (font has these letters?)
        x, y = await to_screen(page, 100, 55); await page.mouse.dblclick(x, y); await page.wait_for_timeout(300)
        await page.keyboard.press("Control+a"); await page.keyboard.type("Quarterly Report 2026"); await page.keyboard.press("Enter")
        await page.wait_for_timeout(800)
        print("toast:", await page.locator("#toast").text_content())
        # move the image right and up
        x, y = await to_screen(page, 200, 330); await drag(page, x, y, x + 180, y - 40)
        # resize via handle
        h = await page.locator("[data-edit-handle]").bounding_box()
        await drag(page, h["x"] + 4, h["y"] + 4, h["x"] - 60, h["y"] - 20)
        # delete italic closing line
        x, y = await to_screen(page, 120, 425); await page.mouse.click(x, y); await page.keyboard.press("Delete")
        await page.wait_for_timeout(300)
        # nudge the "Course" table cell text 
        e = await objs(page); print("objEdits:", json.dumps(e)[:400])
        await page.keyboard.press("Control+z"); n1 = len([k for k, v in (await objs(page)).items() if v.get('hidden')])
        await page.keyboard.press("Control+y"); n2 = len([k for k, v in (await objs(page)).items() if v.get('hidden')])
        print("undo/redo hidden count:", n1, n2)
        await page.wait_for_timeout(1500); await page.screenshot(path=f"{OUT}/e1-doc.png")
        f = await save(page, "doc-edited.pdf"); print("saved", f)
        # ---------- Chrome PDF ----------
        await openfile(page, "chrome.pdf")
        await page.keyboard.press("x"); await page.wait_for_timeout(300)
        x, y = await to_screen(page, 60, 110); await page.mouse.dblclick(x, y); await page.wait_for_timeout(300)
        print("chrome editor value:", await page.locator(".obj-text-editor").input_value())
        await page.keyboard.press("Control+a"); await page.keyboard.type("Amount due: Rs. 50,000"); await page.keyboard.press("Enter")
        x, y = await to_screen(page, 80, 207); await drag(page, x, y, x + 100, y + 120)
        await page.wait_for_timeout(1500); await page.screenshot(path=f"{OUT}/e2-chrome.png")
        await save(page, "chrome-edited.pdf")
        # ---------- Urdu replacement + base-rotated + scanned ----------
        await openfile(page, "sample.pdf")
        await page.keyboard.press("x"); await page.wait_for_timeout(300)
        x, y = await to_screen(page, 100, 137); await page.mouse.dblclick(x, y); await page.wait_for_timeout(300)
        await page.keyboard.press("Control+a"); await page.keyboard.type("یہ لائن اردو میں بدل دی گئی ہے"); await page.keyboard.press("Enter")
        await page.wait_for_timeout(1500); await page.screenshot(path=f"{OUT}/e3-urdu.png")
        await save(page, "sample-urdu-edit.pdf")
        await openfile(page, "scan.pdf"); await page.keyboard.press("x")
        x, y = await to_screen(page, 300, 300); await page.mouse.click(x, y); await page.wait_for_timeout(300)
        print("scan label:", await page.locator(".ctx-label").text_content())
        await openfile(page, "rotated.pdf"); await page.keyboard.press("x"); await page.wait_for_timeout(500)
        an = await page.evaluate("1")
        await page.screenshot(path=f"{OUT}/e4-rotated.png")
        print("errors:", errs)
        await b.close()
    # Verify the saved files: replaced/deleted text must really be gone.
    import pypdfium2 as pdfium
    def text(f): return pdfium.PdfDocument(f"{OUT}/{f}")[0].get_textpage().get_text_range()
    t = text("doc-edited.pdf")
    assert "Waqas" not in t and "Ali Raza" in t and "Quarterly Report 2026" in t and "Italic closing" not in t, t
    t = text("chrome-edited.pdf")
    assert "50,000" in t and "45,000" not in t, t
    t = text("sample-urdu-edit.pdf")
    assert "Line 1:" not in t and "اردو" in t, t
    assert not errs, errs
    print("EDIT PDF TESTS PASSED")
asyncio.run(main())
