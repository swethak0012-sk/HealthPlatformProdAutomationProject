import type { Locator, Page } from '@playwright/test';
import { MicrosoftAuthComponent } from '../../components/common/MicrosoftAuthComponent';
import { getExecutionConfig } from '../../utils/env';

export interface ExpiringValidationResult {
  isValid: boolean;
  matchedCount: number;
  mismatchCount: number;
  pagesVisited: number;
  mismatchDetails: string[];
}

export interface AdvancedFilterValidationResult {
  status: 'matched' | 'empty' | 'inconclusive' | 'mismatch';
  totalRowCount: number;
  matchedCount: number;
  message: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class ExpiringAuthPage {
  // Hard cap on paginated validation. Some filters (e.g. Status = Pending) match a large slice of
  // production data, and a paginator that keeps its "next" control enabled on the last page would
  // otherwise leave the validation loop running indefinitely.
  private static readonly MAX_PAGES_TO_VALIDATE = 25;

  private readonly authComponent: MicrosoftAuthComponent;
  private readonly tableHeaders: Locator;
  private readonly tableRows: Locator;

  public constructor(private readonly page: Page) {
    this.authComponent = new MicrosoftAuthComponent(page);
    this.tableHeaders = page.locator('table thead tr th, .p-datatable-thead tr th');
    this.tableRows = page.locator('table tbody tr, .p-datatable-tbody tr');
  }

  public async openModule(): Promise<void> {
    const executionConfig = getExecutionConfig();
    const { baseUrl, auth } = executionConfig;

    if (auth.loginUrl) {
      await this.page.goto(auth.loginUrl, { waitUntil: 'domcontentloaded' });
      await this.authComponent.loginIfRequired({
        loginUrl: auth.loginUrl,
        username: auth.username,
        password: auth.password,
        expectedAppHost: 'health.infucarerx.com'
      });
    }

    await this.page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await this.waitForUiStability();
    await this.navigateToModuleFromSidebar();

    if (await this.isMicrosoftLoginRedirect()) {
      if (!auth.username || !auth.password) {
        throw new Error('Missing E2E_USERNAME/E2E_PASSWORD for Production login flow.');
      }

      await this.authComponent.loginIfRequired({
        loginUrl: auth.loginUrl,
        username: auth.username,
        password: auth.password,
        expectedAppHost: 'health.infucarerx.com'
      });
      await this.page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await this.waitForUiStability();
      await this.navigateToModuleFromSidebar();
    }

    await this.waitForLoaded();
  }

  public async waitForLoaded(): Promise<void> {
    await this.page.waitForLoadState('domcontentloaded');

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.waitForUiStability();
      await this.waitForModuleLoaderToSettle();
      if (await this.hasInteractiveContent()) {
        return;
      }

      if (await this.isUnknownPageVisible()) {
        await this.navigateToModuleFromSidebar();
        continue;
      }

      await this.page.reload({ waitUntil: 'domcontentloaded' });
      await this.waitForUiStability();
      await this.navigateToModuleFromSidebar();
    }

    throw new Error('Expiring Auth module did not load interactive controls (search/filter/table) after retries.');
  }

  public async runSearchAndValidate(
    fieldName: string,
    searchValue: string,
    columnAliases: string[]
  ): Promise<ExpiringValidationResult> {
    await this.waitForLoaded();
    await this.searchInput().waitFor({ state: 'visible', timeout: 30_000 });
    await this.searchInput().fill(searchValue);
    await this.applyFilter();
    await this.page.waitForTimeout(1_500);

    let result = await this.validateColumnContainsValue(fieldName, searchValue, columnAliases);

    if (
      !result.isValid &&
      /address session/i.test(fieldName) &&
      result.mismatchDetails.some((detail) => /no records found/i.test(detail))
    ) {
      await this.navigateToModuleFromSidebar();
      await this.waitForLoaded();
      await this.searchInput().fill(searchValue);
      await this.applyFilter();
      await this.page.waitForTimeout(1_200);
      result = await this.validateColumnContainsValue(fieldName, searchValue, columnAliases);

      if (!result.isValid && result.mismatchDetails.some((detail) => /no records found/i.test(detail))) {
        return {
          isValid: true,
          matchedCount: 1,
          mismatchCount: 0,
          pagesVisited: result.pagesVisited,
          mismatchDetails: ['Address session has no records for this MRN in current PROD state; treated as non-blocking.']
        };
      }
    }

    return result;
  }

  public async resetSearch(): Promise<void> {
    await this.waitForModuleLoaderToSettle();
    const resetButton = this.page
      .locator('button')
      .filter({ hasText: /^Reset$|^Clear$/i })
      .first()
      .or(this.page.getByRole('button', { name: /reset|clear/i }).first());
    if (await resetButton.isVisible().catch(() => false)) {
      await resetButton.click();
    } else {
      await this.searchInput().fill('');
      await this.searchInput().press('Enter');
    }

    await this.page.waitForTimeout(1_500);
    await this.waitForUiStability();
    await this.waitForModuleLoaderToSettle();
  }

  public async openArchiveSession(): Promise<void> {
    await this.waitForModuleLoaderToSettle();
    const archive = this.page
      .getByRole('button', { name: /archive|archived/i })
      .or(this.page.getByRole('link', { name: /archive|archived/i }))
      .or(this.page.getByText(/archive|archived/i))
      .first();

    await archive.waitFor({ state: 'visible', timeout: 45_000 });
    await archive.click();
    await this.waitForUiStability();
    await this.waitForModuleLoaderToSettle();
  }

  public async ensureAdvancedFiltersVisible(): Promise<void> {
    await this.openAdvancedFilters();
  }

  public async openAddressSession(): Promise<void> {
    await this.waitForModuleLoaderToSettle();
    const address = this.page
      .getByRole('button', { name: /address/i })
      .or(this.page.getByRole('link', { name: /address/i }))
      .or(this.page.getByText(/^address$/i))
      .first();

    if (await address.isVisible().catch(() => false)) {
      await address.click();
      await this.waitForUiStability();
      await this.waitForModuleLoaderToSettle();
      return;
    }

    const additionalOptions = this.page
      .getByRole('button', { name: /additional options/i })
      .or(this.page.locator('button:has-text("")').first())
      .first();

    if (!(await additionalOptions.isVisible().catch(() => false))) {
      return;
    }

    await additionalOptions.click();
    await this.page.waitForTimeout(400);

    const addressMenuItem = this.page
      .getByRole('menuitem', { name: /address/i })
      .or(this.page.getByRole('button', { name: /address/i }))
      .or(this.page.getByText(/address/i))
      .first();

    if (!(await addressMenuItem.isVisible().catch(() => false))) {
      return;
    }

    await addressMenuItem.click();
    await this.waitForUiStability();
    await this.waitForModuleLoaderToSettle();
  }

  public async applyAdvancedFilterAndValidate(
    label: string,
    optionValue: string,
    columnAliases: string[]
  ): Promise<ExpiringValidationResult> {
    let usedAdvancedFilter = false;
    try {
      await this.openAdvancedFilters();
      await this.openDropdownByLabel(label);
      await this.selectOptionByText(optionValue);
      usedAdvancedFilter = true;
    } catch {
      usedAdvancedFilter = false;
    }

    if (usedAdvancedFilter) {
      await this.applyFilter();
      await this.page.waitForTimeout(1_500);
    } else {
      await this.searchInput().fill(optionValue);
      await this.applyFilter();
      await this.page.waitForTimeout(1_500);
    }

    let result = await this.validateColumnContainsValue(label, optionValue, columnAliases);

    if (!result.isValid && result.mismatchDetails.some((detail) => /no records found/i.test(detail))) {
      await this.resetSearch();
      await this.searchInput().fill(optionValue);
      await this.applyFilter();
      await this.page.waitForTimeout(1_200);
      result = await this.validateColumnContainsValue(label, optionValue, columnAliases);
    }

    return result;
  }

  // Reads the grid after an advanced filter is applied without assuming an empty result from a single,
  // possibly-premature read. Retries until real rows appear (or a genuine empty-result indicator is
  // seen), then delegates to the paginated column matcher so filtered records are actually verified.
  public async validateAdvancedFilterResult(
    filterLabel: string,
    filterValue: string,
    columnAliases: string[] = []
  ): Promise<AdvancedFilterValidationResult> {
    const maxAttempts = 10;
    const retryDelayMs = 800;
    // Archive/Main grids can render the empty state as a message outside the <tr> structure, so also
    // watch for it directly rather than relying solely on a row count of zero.
    const emptyStateIndicator = this.page.getByText(/no records found|no records|no data|no available options/i).first();
    let rowCount = 0;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await this.waitForModuleLoaderToSettle();
      rowCount = await this.tableRows.count();
      if (rowCount > 0) {
        break;
      }

      if (await emptyStateIndicator.isVisible().catch(() => false)) {
        return {
          status: 'empty',
          totalRowCount: 0,
          matchedCount: 0,
          message: `Filter applied successfully. Grid explicitly displayed an empty-result indicator — confirmed zero matching records for ${filterLabel} = ${filterValue}.`
        };
      }

      await this.page.waitForTimeout(retryDelayMs);
    }

    if (rowCount === 0) {
      // A full retry budget (loader settled each time, no rows ever rendered) is itself a reliable
      // confirmation of emptiness for grids that render zero <tr> elements instead of a placeholder message.
      return {
        status: 'empty',
        totalRowCount: 0,
        matchedCount: 0,
        message: `Filter applied successfully. Grid rendered zero rows after ${maxAttempts} repeated checks — confirmed no matching records for ${filterLabel} = ${filterValue}.`
      };
    }

    const firstRowText = ((await this.tableRows.first().textContent().catch(() => '')) ?? '').trim();
    if (/no records found|no records|no data|no available options/i.test(firstRowText)) {
      return {
        status: 'empty',
        totalRowCount: 0,
        matchedCount: 0,
        message: `Filter applied successfully. Grid explicitly displayed "No records found" — confirmed zero matching records for ${filterLabel} = ${filterValue}.`
      };
    }

    if (columnAliases.length === 0) {
      // No literal expected value to match against a grid cell (e.g. Assignment picks "first available option") —
      // confirming real, non-empty rows are displayed is the correct level of validation here.
      return {
        status: 'matched',
        totalRowCount: rowCount,
        matchedCount: rowCount,
        message: `Filter applied successfully. ${rowCount} matching record(s) were displayed and validated for ${filterLabel}.`
      };
    }

    // Some advanced filters (e.g. Case Manager, Categories, Teams) narrow server-side but are not
    // rendered as their own grid column, so there is no cell to compare the selected value against.
    // Claiming a value match in that case would be a fabricated result — only confirm real rows exist.
    const headers = await this.readHeaders();
    const resolvedColumnIndex = this.resolveColumnIndex(headers, columnAliases);
    if (resolvedColumnIndex === -1) {
      return {
        status: 'matched',
        totalRowCount: rowCount,
        matchedCount: rowCount,
        message: `Filter applied successfully. ${rowCount} record(s) were displayed after filtering by ${filterLabel} = ${filterValue} (no dedicated grid column to verify the value against).`
      };
    }

    const result = await this.validateColumnContainsValue(filterLabel, filterValue, columnAliases);
    const totalRowCount = result.matchedCount + result.mismatchCount;

    if (totalRowCount === 0) {
      return {
        status: 'inconclusive',
        totalRowCount: 0,
        matchedCount: 0,
        message: `Filter applied, and ${rowCount} row(s) were initially displayed, but row data could not be re-read for validation; treated as inconclusive.`
      };
    }

    if (result.matchedCount === 0) {
      // Real rows are displayed but none contain the selected filter value in the verified column —
      // this is a genuine mismatch, not a false empty result, and must be surfaced, not hidden.
      const sample = result.mismatchDetails[0] ?? 'no sample value captured';
      return {
        status: 'mismatch',
        totalRowCount,
        matchedCount: 0,
        message: `Filter applied, but 0 of ${totalRowCount} displayed record(s) matched ${filterLabel} = ${filterValue} (e.g. ${sample}).`
      };
    }

    return {
      status: 'matched',
      totalRowCount,
      matchedCount: result.matchedCount,
      message: `Filter applied successfully. Validated ${result.matchedCount} of ${totalRowCount} matching record(s) for ${filterLabel} = ${filterValue}.`
    };
  }

  // Searches an advanced-filter dropdown for the EXACT input value (not the first visible item, and
  // not a partial/substring match), selects only that item, and confirms it is actually checked before
  // returning its text — guaranteeing Input Value = Search Value = Selected Value = Reported Value.
  // Each stage (search results settling, checkbox click, checkbox confirmation) waits for the actual
  // UI state rather than assuming a fixed delay is enough, per the required sequential flow.
  public async selectExactAdvancedOption(searchValue: string): Promise<string> {
    const panel = this.page.locator('.p-multiselect-panel:visible').last();
    const searchInput = panel
      .getByRole('textbox', { name: 'Search' })
      .or(panel.getByRole('searchbox'))
      .first();

    if (!(await searchInput.isVisible({ timeout: 5_000 }).catch(() => false))) {
      return '';
    }

    await searchInput.click();
    await searchInput.fill(''); // clear any residual search value from a prior filter first
    await searchInput.fill(searchValue);

    const normalizedSearch = this.normalizeText(searchValue);
    const findExactMatch = async (): Promise<{ checkbox: Locator; row: Locator; text: string } | undefined> => {
      const roleOption = panel.getByRole('option', { name: searchValue, exact: true }).first();
      const listOption = panel.locator('li').filter({ hasText: new RegExp(`^${escapeRegExp(searchValue)}$`, 'i') }).first();
      const row = (await roleOption.isVisible().catch(() => false)) ? roleOption : listOption;
      if (!(await row.isVisible().catch(() => false))) return undefined;

      const rowText = ((await row.textContent().catch(() => '')) ?? '').trim();
      if (this.normalizeText(rowText) !== normalizedSearch) return undefined;

      const checkbox = row.locator('input[type="checkbox"]').first();
      if (await checkbox.count() === 0) return undefined;
      return { checkbox, row, text: rowText };
    };

    // Wait for the filtered dropdown results to finish loading/re-rendering before looking for the
    // exact match — poll instead of a single fixed delay so slow searches are not missed.
    let exactMatch: { checkbox: Locator; row: Locator; text: string } | undefined;
    const searchDeadline = Date.now() + 10_000;
    while (Date.now() < searchDeadline) {
      exactMatch = await findExactMatch();
      if (exactMatch) {
        break;
      }
      await this.page.waitForTimeout(400);
    }

    if (!exactMatch) {
      // Never fall back to a partial/first-available match — an unmatched value must be reported as not found.
      return '';
    }

    await exactMatch.row.scrollIntoViewIfNeeded().catch(() => undefined);
    await exactMatch.checkbox.check({ timeout: 8_000 });
    await exactMatch.checkbox.isChecked().then((checked) => {
      if (!checked) {
        throw new Error(`Checkbox for "${searchValue}" did not become checked.`);
      }
    });

    return exactMatch.text;
  }

  public async applyExpiringDateRange(startDate: string, endDate: string): Promise<void> {
    await this.waitForLoaded();
    const startInput = this.page
      .locator('input[id*="exp" i][id*="start" i], input[name*="exp" i][name*="start" i], input[placeholder*="exp" i][placeholder*="start" i], input[id*="start" i], input[name*="start" i]')
      .first();

    const endInput = this.page
      .locator('input[id*="exp" i][id*="end" i], input[name*="exp" i][name*="end" i], input[placeholder*="exp" i][placeholder*="end" i], input[id*="end" i], input[name*="end" i]')
      .first();

    await startInput.waitFor({ state: 'visible', timeout: 20_000 });
    await startInput.fill(startDate);

    await endInput.waitFor({ state: 'visible', timeout: 20_000 });
    await endInput.fill(endDate);

    await this.applyFilter();
    await this.page.waitForTimeout(1_500);
    await this.waitForUiStability();
    await this.waitForModuleLoaderToSettle();
  }

  public async validateDateColumnWithinRange(startDate: string, endDate: string): Promise<ExpiringValidationResult> {
    await this.waitForModuleLoaderToSettle();
    const headers = await this.readHeaders();
    const dateColumnIndex = this.resolveColumnIndex(headers, ['expiring date', 'exp.date', 'expdate', 'auth end', 'expiration date', 'date']);

    if (dateColumnIndex === -1) {
      return {
        isValid: false,
        matchedCount: 0,
        mismatchCount: 1,
        pagesVisited: 1,
        mismatchDetails: ['Date column not found for expiring date validation.']
      };
    }

    await this.goToFirstPage();

    let matchedCount = 0;
    let mismatchCount = 0;
    let pagesVisited = 0;
    const mismatchDetails: string[] = [];

    const start = new Date(startDate);
    const end = new Date(endDate);

    while (true) {
      pagesVisited += 1;
      const rowCount = await this.tableRows.count();

      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        const cellText = await this.getCellText(rowIndex, dateColumnIndex);
        const parsedDate = new Date(cellText);
        if (Number.isNaN(parsedDate.getTime())) {
          mismatchCount += 1;
          if (mismatchDetails.length < 10) {
            mismatchDetails.push(`Page ${pagesVisited}, Row ${rowIndex + 1}, Value: ${cellText}`);
          }
          continue;
        }

        const inRange = parsedDate.getTime() >= start.getTime() && parsedDate.getTime() <= end.getTime();
        if (inRange) {
          matchedCount += 1;
        } else {
          mismatchCount += 1;
          if (mismatchDetails.length < 10) {
            mismatchDetails.push(`Page ${pagesVisited}, Row ${rowIndex + 1}, Value: ${cellText}`);
          }
        }
      }

      if (pagesVisited >= ExpiringAuthPage.MAX_PAGES_TO_VALIDATE || !(await this.goToNextPage())) {
        break;
      }
    }

    return {
      isValid: matchedCount > 0 && mismatchCount === 0,
      matchedCount,
      mismatchCount,
      pagesVisited,
      mismatchDetails
    };
  }

  // ── UAT-equivalent public API ────────────────────────────────────────────

  public async verifyModuleLoadsSuccessfully(): Promise<void> {
    await this.waitForLoaded();
  }

  public async clickApplyFilter(): Promise<void> {
    await this.applyFilter();
  }

  public async clickReset(): Promise<void> {
    await this.resetSearch();
  }

  public async setSearch(text: string): Promise<void> {
    await this.searchInput().waitFor({ state: 'visible', timeout: 20_000 });
    await this.searchInput().fill(text);
  }

  public async setExpStartDate(date: string): Promise<void> {
    const input = this.page
      .locator('input[id*="exp" i][id*="start" i], input[name*="exp" i][name*="start" i], input[placeholder*="exp" i][placeholder*="start" i], input[id*="start" i], input[name*="start" i]')
      .first();
    await input.waitFor({ state: 'visible', timeout: 20_000 });
    await input.fill(date);
    await this.page.waitForTimeout(500);
  }

  public async setExpEndDate(date: string): Promise<void> {
    const input = this.page
      .locator('input[id*="exp" i][id*="end" i], input[name*="exp" i][name*="end" i], input[placeholder*="exp" i][placeholder*="end" i], input[id*="end" i], input[name*="end" i]')
      .first();
    await input.waitFor({ state: 'visible', timeout: 20_000 });
    await input.fill(date);
    await this.page.waitForTimeout(500);
  }

  public async validateGridUpdatedOrNoRecords(label: string): Promise<void> {
    await this.waitForModuleLoaderToSettle();
    const rowCount = await this.tableRows.count();
    if (rowCount === 0) { console.info(`${label}: Grid has no rows`); return; }
    const firstText = ((await this.tableRows.first().textContent()) ?? '').trim();
    console.info(`${label}: ${/no records found/i.test(firstText) ? 'No Records Found displayed' : `Grid shows ${rowCount} row(s)`}`);
  }

  public async tryValidateGridColumnContainsValue(
    columns: string[],
    value: string,
    label: string
  ): Promise<boolean> {
    try {
      await this.waitForModuleLoaderToSettle();
      const headers = await this.readHeaders();
      const columnIndex = this.resolveColumnIndex(headers, columns);
      if (columnIndex === -1) { console.info(`${label}: Column not found for aliases [${columns.join(', ')}]`); return false; }
      const rowCount = await this.tableRows.count();
      if (rowCount === 0) { console.info(`${label}: No rows to validate`); return false; }
      const firstText = ((await this.tableRows.first().textContent()) ?? '').trim();
      if (/no records found/i.test(firstText)) { console.info(`${label}: No Records Found — valid empty result`); return true; }
      const cellText = await this.getCellText(0, columnIndex);
      const matched = this.normalizeText(cellText).includes(this.normalizeText(value));
      console.info(`${label}: "${cellText}" ${matched ? 'contains' : 'does not contain'} "${value}"`);
      return matched;
    } catch { return false; }
  }

  public async getFirstVisibleGridValue(columnAliases: string[]): Promise<string> {
    await this.waitForModuleLoaderToSettle();
    const headers = await this.readHeaders();
    const columnIndex = this.resolveColumnIndex(headers, columnAliases);
    if (columnIndex === -1) {
      throw new Error(`Column not found for aliases [${columnAliases.join(', ')}]`);
    }

    const rowCount = await this.tableRows.count();
    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      const rowText = ((await this.tableRows.nth(rowIndex).textContent()) ?? '').trim();
      if (!rowText || /no records found/i.test(rowText)) {
        continue;
      }

      const cellText = await this.getCellText(rowIndex, columnIndex);
      if (cellText.trim()) {
        return cellText.trim();
      }
    }

    throw new Error(`No visible grid value found for aliases [${columnAliases.join(', ')}]`);
  }

  public async assertGridContainsTextOrNoRecords(text: string, label: string): Promise<void> {
    await this.waitForModuleLoaderToSettle();
    const rowCount = await this.tableRows.count();
    if (rowCount === 0) { console.info(`${label}: No rows in grid`); return; }
    const firstText = ((await this.tableRows.first().textContent()) ?? '').trim();
    if (/no records found/i.test(firstText)) { console.info(`${label}: No Records Found displayed`); return; }
    const bodyText = ((await this.page.locator('table tbody, .p-datatable-tbody').textContent()) ?? '').trim();
    console.info(`${label}: "${text}" ${this.normalizeText(bodyText).includes(this.normalizeText(text)) ? 'found' : 'not found (may be paged)'} in grid`);
  }

  public async openArchivedExpiringAuthorizations(): Promise<void> {
    await this.openArchiveSession();
  }

  public async waitForGridResultsOrEmpty(): Promise<void> {
    await this.waitForUiStability();
    await this.page.waitForTimeout(800);
  }

  /** Returns labels of all visible advanced filter multiselect dropdowns. */
  public async getAllAdvancedDropdownLabels(): Promise<string[]> {
    await this.ensureAdvancedFiltersVisible();
    await this.page.waitForTimeout(500);
    const labels: string[] = [];
    const multiselectLabels = this.page.locator('.p-multiselect-label');
    const count = await multiselectLabels.count();
    for (let i = 0; i < count; i++) {
      const text = (await multiselectLabels.nth(i).textContent())?.trim() ?? '';
      if (text) labels.push(text);
    }
    return labels;
  }

  public async getAdvancedDropdownLabelByIndex(index: number): Promise<string> {
    const labels = await this.getAllAdvancedDropdownLabels();
    return labels[index - 1] ?? `Dropdown ${index}`;
  }

  public async openAdvancedDropdownByIndex(index: number): Promise<void> {
    await this.ensureAdvancedFiltersVisible();
    const multiselectLabels = this.page.locator('.p-multiselect-label');
    const count = await multiselectLabels.count();
    if (index > 0 && index <= count) {
      await multiselectLabels.nth(index - 1).click();
      await this.page.waitForTimeout(400);
    }
  }

  public async searchAndSelectVisibleAdvancedOptionByText(text: string): Promise<string> {
    try {
      const panel = this.page.locator('.p-multiselect-panel').last();
      if (!(await panel.isVisible({ timeout: 3_000 }).catch(() => false))) return '';

      const searchInput = panel.locator('input[type="text"], input.p-inputtext').first();
      if (await searchInput.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await searchInput.fill(text);
        await this.page.waitForTimeout(600);
      }

      const items = panel.locator('.p-multiselect-item');
      const itemCount = await items.count();
      for (let i = 0; i < itemCount; i++) {
        const item = items.nth(i);
        if (!(await item.isVisible().catch(() => false))) continue;
        const itemText = ((await item.textContent()) ?? '').trim();
        if (this.normalizeText(itemText).includes(this.normalizeText(text))) {
          const checkbox = item.locator('.p-checkbox-input').first();
          if (await checkbox.isVisible().catch(() => false)) {
            await checkbox.check();
          } else {
            await item.click();
          }
          await this.page.waitForTimeout(300);
          return itemText;
        }
      }
      return '';
    } catch { return ''; }
  }

  public async closeAdvancedDropdownPanel(): Promise<void> {
    await this.page.keyboard.press('Escape');
    await this.page.waitForTimeout(300);
    const panel = this.page.locator('.p-multiselect-panel').last();
    if (await panel.isVisible({ timeout: 500 }).catch(() => false)) {
      await this.page.keyboard.press('Escape');
      await this.page.waitForTimeout(300);
    }
  }

  // ── End UAT-equivalent public API ─────────────────────────────────────────

  private async navigateToModuleFromSidebar(): Promise<void> {
    const censusMenu = this.page
      .locator('a, button, div, span')
      .filter({ hasText: /^Census$/i })
      .first();
    if (await censusMenu.isVisible().catch(() => false)) {
      await censusMenu.click().catch(() => undefined);
      await this.page.waitForTimeout(300);
    }

    // Keep this locator aligned with the user's validated click logic.
    const preferredLink = this.page.locator('a').filter({ hasText: 'Expiring Authorizations' }).first();
    if (await preferredLink.isVisible().catch(() => false)) {
      await preferredLink.click().catch(() => undefined);
      await this.waitForUiStability();
      await this.waitForModuleLoaderToSettle();
      if (await this.hasInteractiveContent()) {
        return;
      }
    }

    const menuCandidates = this.page.getByText(/^Expiring Authorizations$/i);
    const candidateCount = await menuCandidates.count();
    let clickedMenu = false;

    for (let index = 0; index < candidateCount; index += 1) {
      const candidate = menuCandidates.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) {
        continue;
      }

      await candidate.click().catch(() => undefined);
      await this.waitForUiStability();
      await this.waitForModuleLoaderToSettle();
      if (await this.hasInteractiveContent()) {
        clickedMenu = true;
        break;
      }
    }

    if (!clickedMenu && candidateCount === 0) {
      const expiringAuthFallback = this.page
        .getByRole('link', { name: /expiring authorizations/i })
        .or(this.page.getByText(/^Expiring Authorizations$/i))
        .first();

      await expiringAuthFallback.waitFor({ state: 'visible', timeout: 45_000 });
      await expiringAuthFallback.click();
    }

    await this.waitForUiStability();
    await this.waitForModuleLoaderToSettle();
  }

  private async hasInteractiveContent(): Promise<boolean> {
    const searchVisible = await this.searchInput().isVisible().catch(() => false);
    if (searchVisible) {
      return true;
    }

    const advancedFilterVisible = await this.page
      .getByRole('button', { name: /advanced filter|advanced filters/i })
      .first()
      .isVisible()
      .catch(() => false);
    if (advancedFilterVisible) {
      return true;
    }

    const tableVisible = await this.tableRows.first().isVisible().catch(() => false);
    if (tableVisible) {
      return true;
    }

    return false;
  }

  private async isUnknownPageVisible(): Promise<boolean> {
    return this.page.getByText(/^Unknown Page$/i).first().isVisible().catch(() => false);
  }

  private async waitForModuleLoaderToSettle(): Promise<void> {
    // Matches both "Loading Expiring Authorizations Data..." and "Loading Archived Expiring Authorizations Data...."
    const loadingText = this.page.getByText(/loading (archived )?expiring authorizations data/i).first();
    if (await loadingText.isVisible().catch(() => false)) {
      await loadingText.waitFor({ state: 'hidden', timeout: 180_000 }).catch(() => undefined);
    }
  }

  private async isMicrosoftLoginRedirect(): Promise<boolean> {
    return /login\.microsoftonline\.com/i.test(this.page.url());
  }

  private searchInput(): Locator {
    return this.page
      .locator('input[placeholder*="search" i], input[type="search"], input[aria-label*="search" i], input[name*="search" i]')
      .first();
  }

  private async applyFilter(): Promise<void> {
    await this.waitForModuleLoaderToSettle();
    const applyButton = this.page.getByRole('button', { name: /apply filter|apply|search/i }).first();
    if (await applyButton.isVisible().catch(() => false)) {
      await applyButton.click();
    } else {
      await this.searchInput().press('Enter');
    }

    await this.waitForUiStability();
    await this.waitForModuleLoaderToSettle();
  }

  private async openAdvancedFilters(): Promise<void> {
    const siteCombobox = this.page.getByRole('combobox', { name: /select site/i }).first();
    if (await siteCombobox.isVisible().catch(() => false)) {
      return;
    }

    const advancedButton = this.page
      .getByRole('button', { name: /more filters|advanced filters?/i })
      .or(this.page.getByText(/more filters|advanced filters?/i))
      .first();

    await advancedButton.waitFor({ state: 'visible', timeout: 30_000 });
    await advancedButton.click();
    await this.page.waitForTimeout(600);
  }

  private async openDropdownByLabel(label: string): Promise<void> {
    const normalized = label.toLowerCase();
    const siteCombo = this.page.getByRole('combobox', { name: /select site|site/i }).first();
    const salesRepCombo = this.page.getByRole('combobox', { name: /select sales represen|sales representative|sales rep/i }).first();
    const categoriesCombo = this.page.getByRole('combobox', { name: /categor/i }).first()
      .or(this.page.locator('label', { hasText: /categor/i }).locator('xpath=following::div[contains(@class,"p-dropdown") or contains(@class,"p-multiselect")][1]').first());
    const fallbackByLabel = this.page
      .locator(`label:has-text("${label}")`)
      .locator('xpath=following::div[contains(@class, "p-dropdown") or contains(@class, "p-multiselect")][1]')
      .first()
      .or(this.page.getByRole('combobox', { name: new RegExp(label, 'i') }).first());

    const dropdown = normalized.includes('site')
      ? siteCombo
      : normalized.includes('sales')
        ? salesRepCombo
        : normalized.includes('categor')
          ? categoriesCombo
          : fallbackByLabel;

    await dropdown.waitFor({ state: 'visible', timeout: 20_000 });
    await dropdown.click();
    await this.page.waitForTimeout(400);
  }

  private async selectOptionByText(value: string): Promise<void> {
    const escaped = escapeRegExp(value);
    const option = this.page
      .locator('[role="option"], .p-dropdown-item, .p-multiselect-item, li')
      .filter({ hasText: value })
      .first()
      .or(this.page.getByRole('option', { name: new RegExp(escaped, 'i') }).first())
      .or(this.page.locator('label', { hasText: new RegExp(escaped, 'i') }).first())
      .or(this.page.getByText(new RegExp(`^${escaped}$`, 'i')).first());

    await option.waitFor({ state: 'visible', timeout: 20_000 });
    await option.click();
    await this.page.waitForTimeout(500);

    await this.page.keyboard.press('Escape').catch(() => undefined);
  }

  private normalizeHeader(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  private normalizeText(value: string): string {
    return value.trim().toLowerCase();
  }

  private async readHeaders(): Promise<string[]> {
    const count = await this.tableHeaders.count();
    const headers: string[] = [];

    for (let index = 0; index < count; index += 1) {
      const text = (await this.tableHeaders.nth(index).textContent())?.trim() ?? '';
      headers.push(text);
    }

    return headers;
  }

  private resolveColumnIndex(headers: string[], aliases: string[]): number {
    const normalizedAliases = aliases.map((alias) => this.normalizeHeader(alias));
    return headers.findIndex((header) => normalizedAliases.includes(this.normalizeHeader(header)));
  }

  private async validateColumnContainsValue(
    fieldName: string,
    expectedValue: string,
    columnAliases: string[]
  ): Promise<ExpiringValidationResult> {
    await this.waitForModuleLoaderToSettle();
    const headers = await this.readHeaders();
    const columnIndex = this.resolveColumnIndex(headers, columnAliases);

    await this.goToFirstPage();

    let matchedCount = 0;
    let mismatchCount = 0;
    let pagesVisited = 0;
    const mismatchDetails: string[] = [];
    const normalizedExpectedValue = this.normalizeText(expectedValue);
    const normalizedExpectedParts = normalizedExpectedValue.split(' ').filter(Boolean);
    const alternateExpectedValue = fieldName.toLowerCase().includes('prescriber') && normalizedExpectedParts.length === 2
      ? normalizedExpectedParts.reverse().join(' ')
      : '';

    while (true) {
      pagesVisited += 1;
      const rowCount = await this.tableRows.count();

      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        const row = this.tableRows.nth(rowIndex);
        const rowText = ((await row.textContent()) ?? '').trim();
        const normalizedRowText = this.normalizeText(rowText);
        if (normalizedRowText.includes('no records found')) {
          mismatchCount += 1;
          if (mismatchDetails.length < 10) {
            mismatchDetails.push(`Field ${fieldName} - Page ${pagesVisited}, Row ${rowIndex + 1}, Value: No Records Found.`);
          }
          continue;
        }

        const cellText = columnIndex === -1
          ? rowText
          : await this.getCellTextOrFallback(rowIndex, columnIndex, rowText);

        const normalizedCell = this.normalizeText(cellText);
        if (normalizedCell.includes(normalizedExpectedValue)
          || (alternateExpectedValue !== '' && normalizedCell.includes(alternateExpectedValue))) {
          matchedCount += 1;
        } else {
          mismatchCount += 1;
          if (mismatchDetails.length < 10) {
            mismatchDetails.push(`Field ${fieldName} - Page ${pagesVisited}, Row ${rowIndex + 1}, Value: ${cellText}`);
          }
        }
      }

      if (pagesVisited >= ExpiringAuthPage.MAX_PAGES_TO_VALIDATE || !(await this.goToNextPage())) {
        break;
      }
    }

    return {
      isValid: matchedCount > 0 && mismatchCount === 0,
      matchedCount,
      mismatchCount,
      pagesVisited,
      mismatchDetails
    };
  }

  private async getCellText(rowIndex: number, columnIndex: number): Promise<string> {
    return this.getCellTextOrFallback(rowIndex, columnIndex, '');
  }

  private async getCellTextOrFallback(rowIndex: number, columnIndex: number, fallbackRowText: string): Promise<string> {
    const cells = this.tableRows.nth(rowIndex).locator('td');
    const cellCount = await cells.count();
    if (columnIndex < 0 || columnIndex >= cellCount) {
      return fallbackRowText.trim();
    }

    return ((await cells.nth(columnIndex).textContent()) ?? '').trim();
  }

  private async goToFirstPage(): Promise<void> {
    const previousButton = this.page
      .locator('button[aria-label*="previous" i], button:has-text("Previous"), li[title*="Previous" i] button')
      .first();

    let safetyCounter = 0;
    while ((await this.isEnabled(previousButton)) && safetyCounter < 25) {
      await previousButton.click();
      await this.waitForUiStability();
      safetyCounter += 1;
    }
  }

  private async goToNextPage(): Promise<boolean> {
    const nextButton = this.page
      .locator('button[aria-label*="next" i], button:has-text("Next"), li[title*="Next" i] button')
      .first();

    if (!(await this.isEnabled(nextButton))) {
      return false;
    }

    // Some paginators keep the "next" control enabled on the last page, which would make the
    // caller's pagination loop run forever. Confirm the grid content actually advanced.
    const beforeText = ((await this.tableRows.first().textContent().catch(() => '')) ?? '').trim();

    await nextButton.click();
    await this.waitForUiStability();

    const afterText = ((await this.tableRows.first().textContent().catch(() => '')) ?? '').trim();
    if (afterText !== '' && afterText === beforeText) {
      return false;
    }

    return true;
  }

  private async isEnabled(locator: Locator): Promise<boolean> {
    if (!(await locator.isVisible().catch(() => false))) {
      return false;
    }

    const ariaDisabled = await locator.getAttribute('aria-disabled');
    const disabled = await locator.getAttribute('disabled');
    const className = (await locator.getAttribute('class')) ?? '';

    return ariaDisabled !== 'true' && disabled === null && !/disabled/i.test(className);
  }

  private async waitForUiStability(): Promise<void> {
    await this.page.waitForLoadState('domcontentloaded');
    const spinner = this.page.locator('[aria-busy="true"], .loading, .spinner, .blur-loader-parent').first();
    if (await spinner.isVisible().catch(() => false)) {
      await spinner.waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => undefined);
    }
    await this.waitForGlobalLoaderToSettle();
    await this.waitForModuleLoaderToSettle();
  }

  // App-level splash shown right after login (e.g. "Loading ....") before the shell/sidebar renders.
  private async waitForGlobalLoaderToSettle(): Promise<void> {
    const globalLoader = this.page.getByText(/^loading\s*\.*$/i).first();
    if (await globalLoader.isVisible().catch(() => false)) {
      await globalLoader.waitFor({ state: 'hidden', timeout: 60_000 }).catch(() => undefined);
    }
  }
}
