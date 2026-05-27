import { test as base, expect, chromium, type BrowserContext } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
}>({
  context: async ({ }, use) => {
    const pathToExtension = path.join(__dirname, '../dist');
    const context = await chromium.launchPersistentContext('', {
      headless: false, // Extensions only work in headful mode
      args: [
        `--disable-extensions-except=${pathToExtension}`,
        `--load-extension=${pathToExtension}`,
      ],
    });
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    let [background] = context.serviceWorkers();
    if (!background)
      background = await context.waitForEvent('serviceworker');

    const extensionId = background.url().split('/')[2];
    await use(extensionId);
  },
});

test.describe('D7 Admin Proxy UI', () => {
  
  test('Feature 1: Taxonomy Combobox is injected and syncs', async ({ page }) => {
    await page.goto(`file://${path.join(__dirname, 'fixtures/node-edit.html')}`);

    // Check if original select is hidden
    const nativeSelect = page.locator('select[name="menu[parent]"]');
    await expect(nativeSelect).toBeHidden();

    // Check if Proxy UI is injected (inside Shadow DOM)
    const proxyContainer = page.locator('#d7-proxy-ui-container');
    await expect(proxyContainer).toBeVisible();

    // Access the Shadow DOM to verify components
    const modernSearchLabel = page.locator('#d7-proxy-ui-container >> text=Menu Parent Selector');
    await expect(modernSearchLabel).toBeVisible();

    // Select an item in the modern UI
    await page.click('#d7-proxy-ui-container >> text=Search for a parent...');
    await page.click('#d7-proxy-ui-container >> text=Our Doctors');

    // Verify native select was updated
    const selectedValue = await nativeSelect.inputValue();
    expect(selectedValue).toBe('main-menu:456');
  });

  test('Feature 2: HTML Export button is injected', async ({ page }) => {
    await page.goto(`file://${path.join(__dirname, 'fixtures/node-edit.html')}`);
    
    const exportBanner = page.locator('#d7-proxy-ui-container >> text=Content Extraction Engine');
    await expect(exportBanner).toBeVisible();
    
    const exportButton = page.locator('#d7-proxy-ui-container >> text=Export Raw HTML');
    await expect(exportButton).toBeVisible();
  });

  test('Feature 3: Menu Tree replaces legacy table', async ({ page }) => {
    await page.goto(`file://${path.join(__dirname, 'fixtures/menu-manage.html')}`);

    // Legacy table should be hidden
    const legacyTable = page.locator('table#menu-overview');
    await expect(legacyTable).toBeHidden();

    // Modern manager should be visible
    const modernManager = page.locator('#d7-proxy-ui-container >> text=Main Menu Manager');
    await expect(modernManager).toBeVisible();

    // Verify parsed items are rendered
    const aboutUsItem = page.locator('#d7-proxy-ui-container >> text=About Us');
    await expect(aboutUsItem).toBeVisible();
  });
});
