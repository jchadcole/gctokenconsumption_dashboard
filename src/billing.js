'use strict';
// Official, invoice-grade token figures for the org (not broken down by bot).
//
//   GET /api/v2/billing/contracts
//   GET /api/v2/billing/contracts/{contractId}
//   GET /api/v2/billing/contracts/{contractId}/billingperiods/{billingPeriodId}
//       -> charges[] (product, actualQuantity, convertedTokenCount, tokenConversionRate, overage...)
//       -> wallets[] (token wallet balances: starting, consumption, ending, overage)
//
// Optional and unsupported: GET /api/v2/billing/subscriptionoverview (what the Admin UI calls).

const overlaps = (p, start, end) => (!p.dateEnd || p.dateEnd >= start) && (!p.dateStart || p.dateStart <= end);

async function getBilling(client, { start, end, includeInternal = false }) {
  const out = { contracts: [], periods: [], errors: [], internalOverview: null };
  let contracts = [];
  try {
    contracts = await client.getAllCursor('/api/v2/billing/contracts', { pageSize: 10 });
  } catch (e) {
    out.errors.push(e.status === 403
      ? `Billing contracts: the OAuth client is missing a billing permission (${e.message}).`
      : `Billing contracts unavailable: ${e.message}. Genesys's Contract & Billing API may not be enabled for this org yet; this is not fixed by adding role permissions. Set ENABLE_INTERNAL_SUBSCRIPTION_OVERVIEW=1 to try the endpoint the Admin billing page uses.`);
  }
  for (const c of contracts) {
    let detail = c;
    if (!c.billingPeriods) {
      try { detail = await client.get(`/api/v2/billing/contracts/${encodeURIComponent(c.id)}`); } catch (e) { out.errors.push(e.message); continue; }
    }
    out.contracts.push({ id: detail.id, number: detail.externalNumber, status: detail.status, commercialModel: detail.commercialModel, dateStart: detail.dateStart, dateEnd: detail.dateEnd });
    const periods = (detail.billingPeriods || []).filter((p) => overlaps(p, start, end));
    for (const p of periods) {
      try {
        const pd = await client.get(`/api/v2/billing/contracts/${encodeURIComponent(detail.id)}/billingperiods/${encodeURIComponent(p.id)}`);
        out.periods.push(shapePeriod(detail, pd));
      } catch (e) {
        out.errors.push(`Billing period ${p.id}: ${e.message}`);
      }
    }
  }
  if (includeInternal) {
    try {
      const endMs = new Date(`${end}T23:59:59.999Z`).getTime();
      out.internalOverview = await client.get('/api/v2/billing/subscriptionoverview', { periodEndingTimestamp: endMs });
    } catch (e) {
      out.errors.push(`Internal subscription overview: ${e.message}`);
    }
  }
  return out;
}

function shapePeriod(contract, pd) {
  const charges = (pd.charges || []).map((c) => ({
    name: c.name || c.product?.name,
    sku: c.product?.sku || null,
    unitOfMeasure: c.product?.unitOfMeasure || null,
    actualQuantity: c.actualQuantity ?? null,
    prepaidQuantity: c.prepaidQuantity ?? null,
    overageQuantity: c.overageQuantity ?? null,
    tokens: c.convertedTokenCount ?? null,
    tokenConversionRate: c.tokenConversionRate ?? null,
    overageCharge: c.overageCharge ?? null,
    currency: c.overageCurrency || null,
  }));
  const wallets = (pd.wallets || []).map((w) => ({
    name: w.name || w.product?.name,
    unitOfMeasure: w.unitOfMeasure || w.product?.unitOfMeasure || null,
    startingBalance: w.startingBalance ?? null,
    consumption: w.balanceConsumption ?? null,
    increase: w.balanceIncrease ?? null,
    endingBalance: w.endingBalance ?? null,
    overage: w.balanceOverage ?? null,
    overageCharge: w.balanceOverageCharge ?? null,
    currency: w.balanceOverageCurrency || null,
  }));
  return {
    contractId: contract.id,
    contractNumber: contract.externalNumber,
    id: pd.id,
    dateStart: pd.dateStart,
    dateEnd: pd.dateEnd,
    status: pd.status,
    tokenCharges: charges.filter((c) => c.tokens !== null && c.tokens !== 0),
    otherCharges: charges.filter((c) => c.tokens === null || c.tokens === 0),
    totalTokens: charges.reduce((s, c) => s + (Number(c.tokens) || 0), 0),
    wallets,
  };
}

module.exports = { getBilling };
