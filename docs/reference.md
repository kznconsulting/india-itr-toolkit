# Reference: rates and dates

Compiled 2026-07-16. Rates change with every Finance Act: verify against incometax.gov.in before relying on anything here. When a new AY starts, update this file and add the new slab rules to `scripts/lib/tax.ts`.

## Key dates: AY 2026-27 (income earned in FY 2025-26)

| Event | Date |
|---|---|
| ITR-1 / ITR-2 and other non-audit salaried cases | Jul 31, 2026 |
| ITR-3 / ITR-4 without tax audit (new split, Finance Act 2026) | Aug 31, 2026 |
| Tax-audit cases | Oct 31, 2026 |
| Belated return u/s 139(4) | Dec 31, 2026 |
| Revised return u/s 139(5) (extended by Finance Act 2026) | Mar 31, 2027 |
| E-verification after upload | Within 30 days |

Advance tax for the running year (FY 2026-27): Jun 15 (15%), Sep 15 (45%), Dec 15 (75%), Mar 15 (100%), cumulative, when net liability after TDS is ₹10,000 or more.

## New regime (default, s.115BAC), AY 2026-27

| Slab | Rate |
|---|---|
| Up to ₹4,00,000 | Nil |
| ₹4,00,001 - ₹8,00,000 | 5% |
| ₹8,00,001 - ₹12,00,000 | 10% |
| ₹12,00,001 - ₹16,00,000 | 15% |
| ₹16,00,001 - ₹20,00,000 | 20% |
| ₹20,00,001 - ₹24,00,000 | 25% |
| Above ₹24,00,000 | 30% |

- Standard deduction (salary/pension): ₹75,000
- Rebate u/s 87A: up to ₹60,000 when total income is ₹12,00,000 or less, with marginal relief just above; a salaried income up to ₹12.75L is effectively tax-free
- Deductions still available: 80CCD(2) employer NPS (up to 14% of basic + DA), 80CCH (Agnipath), 80JJAA, family-pension deduction up to ₹25,000
- Surcharge capped at 25%

## Old regime (opt-out), AY 2026-27

| Slab | Rate |
|---|---|
| Up to ₹2,50,000 (₹3L for age 60-79, ₹5L for 80+) | Nil |
| To ₹5,00,000 | 5% |
| To ₹10,00,000 | 20% |
| Above ₹10,00,000 | 30% |

- Standard deduction ₹50,000; rebate u/s 87A up to ₹12,500 when total income is ₹5L or less (no marginal relief)
- Common deductions: 80C ₹1.5L; 80CCD(1B) ₹50k; 80D ₹25k self/family plus ₹25k parents (₹50k if senior); 80TTA ₹10k; 80TTB ₹50k (seniors, replaces 80TTA); 24(b) home-loan interest ₹2L on self-occupied property; HRA and LTA exemptions
- Opting out: salaried can choose per year inside the return; business income needs Form 10-IEA before the due date

## Surcharge (on income tax) and cess

| Total income | Rate |
|---|---|
| Above ₹50L | 10% |
| Above ₹1Cr | 15% |
| Above ₹2Cr | 25% |
| Above ₹5Cr | 37% (old regime only; new regime stays at 25%) |

Marginal relief applies at each threshold. Health and education cess: 4% on tax plus surcharge.

## New regime, AY 2025-26 (for belated/revised filings)

Slabs: 0-3L nil, 3-7L 5%, 7-10L 10%, 10-12L 15%, 12-15L 20%, above 15L 30%. Rebate 87A up to ₹25,000 (total income ₹7L or less). Standard deduction ₹75,000.

## Which ITR form

| Form | Who |
|---|---|
| ITR-1 (Sahaj) | Resident individual, total income up to ₹50L: salary, one house property, other sources; LTCG u/s 112A up to ₹1.25L allowed |
| ITR-2 | Individuals/HUF with capital gains, more than one house property, foreign assets/income, income above ₹50L, directorships or unlisted shares |
| ITR-3 | Business or professional income (non-presumptive) |
| ITR-4 (Sugam) | Presumptive income u/s 44AD/44ADA/44AE, total income up to ₹50L |

## Interest and fees

- 234A: 1% per month on unpaid tax after the due date
- 234B: 1% per month when advance tax paid is under 90% of assessed tax
- 234C: 1% per month for deferring advance-tax instalments
- 234F: late-filing fee ₹5,000 (₹1,000 when total income is ₹5L or less)

Sources checked Jul 2026: [cleartax.in](https://cleartax.in/s/due-date-tax-filing), [indiafilings.com](https://www.indiafilings.com/income-tax-filing/new-due-date-for-filing-itr-2025-26), [caclubindia.com](https://www.caclubindia.com/articles/due-date-for-filing-itr-ay-202627-july-31-vs-august-31-55204.asp), [incometax.gov.in](https://www.incometax.gov.in/iec/foportal/latest-news).
