import asyncio
from playwright.async_api import async_playwright
from paths import APP, FIX, OUT, LAUNCH
OUT = str(OUT)
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**LAUNCH); ctx = await b.new_context(viewport={"width":1440,"height":900}, accept_downloads=True); page = await ctx.new_page()
        errs=[]; page.on("pageerror", lambda e: errs.append(str(e)))
        await page.goto(APP)
        async with page.expect_file_chooser() as fc: await page.get_by_role("button", name="Open PDF").click()
        await (await fc.value).set_files(str(FIX / "rotated.pdf"))
        await page.wait_for_function("window.__pdfEditor.store.pages.length === 2"); await page.wait_for_timeout(800)
        await page.keyboard.press("x")
        # rotated 90deg clockwise: the title "Other page 1" runs top-to-bottom near the right edge
        wb = await page.locator(".page-wrap").first.bounding_box(); print(wb)
        await page.mouse.click(1228, 300); await page.wait_for_timeout(300)
        print("sel:", await page.locator(".ctx-label").text_content())
        await page.mouse.move(1228, 300); await page.mouse.down(); await page.mouse.move(1000, 650, steps=8); await page.mouse.up()
        edits = await page.evaluate("JSON.stringify(window.__pdfEditor.store.pages[0].objEdits)")
        print(edits); assert edits and '"dx"' in edits, "move on a rotated page was not recorded"
        await page.wait_for_timeout(1200); await page.screenshot(path=f"{OUT}/e5-rot.png")
        async with page.expect_download() as dl: await page.get_by_role("button", name="Download").click()
        await (await dl.value).save_as(f"{OUT}/rot-edited.pdf"); print("errors", errs); assert not errs, errs
        print("ROTATED PAGE TEST PASSED")
        await b.close()
asyncio.run(main())
