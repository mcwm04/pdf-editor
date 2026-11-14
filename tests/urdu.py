import asyncio, os
from playwright.async_api import async_playwright
OUT = "/home/claude/test/out"
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(); ctx = await b.new_context(viewport={"width":1440,"height":900}, accept_downloads=True)
        page = await ctx.new_page(); errs=[]
        page.on("console", lambda m: errs.append(m.text) if m.type in ("error","warning") else None)
        page.on("pageerror", lambda e: errs.append(str(e)))
        await page.goto("file:///home/claude/pdf-editor/dist/index.html")
        async with page.expect_file_chooser() as fc:
            await page.get_by_role("button", name="Open PDF").click()
        await (await fc.value).set_files("/home/claude/test/sample.pdf")
        await page.wait_for_function("window.__pdfEditor.store.pages.length === 3")
        bx = await page.locator(".page-wrap").first.bounding_box()
        # 1: Urdu typed into default (Helvetica) box, with an English/number second line
        await page.keyboard.press("t"); await page.mouse.click(bx["x"]+700, bx["y"]+330)
        await page.keyboard.type("پاکستان زندہ باد۔ میرا نام وقاص احمد ہے")
        await page.keyboard.press("Enter"); await page.keyboard.type("میں PDF Editor 2026 استعمال کرتا ہوں")
        await page.wait_for_timeout(300); await page.screenshot(path=f"{OUT}/u0-typing.png")
        await page.keyboard.press("Escape")
        a = await page.evaluate("window.__pdfEditor.store.pages[0].annotations[0]")
        print("ann1:", a["font"], round(a["x"]), round(a["w"]), round(a["h"]))
        # 2: Naskh, bold, chosen from the toolbar
        await page.keyboard.press("Escape"); await page.keyboard.press("t")
        await page.locator(".propbar select[aria-label=Font]").select_option("Naskh")
        await page.locator(".propbar button[aria-label=Bold]").click()
        await page.mouse.click(bx["x"]+700, bx["y"]+560)
        await page.keyboard.type("یونیورسٹی آف ایگریکلچر، فیصل آباد")
        await page.keyboard.press("Escape")
        # 3: English stays Helvetica
        await page.keyboard.press("Escape"); await page.keyboard.press("t")
        await page.locator(".propbar select[aria-label=Font]").select_option("Helvetica")
        await page.locator(".propbar button[aria-label=Bold]").click()
        await page.mouse.click(bx["x"]+100, bx["y"]+700)
        await page.keyboard.type("English still works")
        await page.keyboard.press("Escape")
        anns = await page.evaluate("window.__pdfEditor.store.pages[0].annotations.map(a=>[a.font,a.bold,a.text])")
        print(anns)
        await page.keyboard.press("v"); await page.wait_for_timeout(300)
        await page.screenshot(path=f"{OUT}/u1-screen.png")
        async with page.expect_download() as dl:
            await page.get_by_role("button", name="Download").click()
        d = await dl.value; await d.save_as(f"{OUT}/urdu-out.pdf")
        print("toast:", await page.locator("#toast").text_content())
        # what the page looks like at the same zoom, for comparison
        print("zoom", await page.evaluate("window.__pdfEditor.viewer.zoom"))
        print("errors:", errs)
        await b.close()
asyncio.run(main())
