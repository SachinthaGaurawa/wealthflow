/* =============================================================================
 * statement-conversion.mjs — a purchase turned into an instalment plan is not spending twice, and not a payment
 * -----------------------------------------------------------------------------
 * Nations Trust Bank prints the conversion of a card purchase into a plan as THREE lines on one day:
 *     SINGER 24M NATIONS PAY                          125,260.00 Cr     <- the purchase is taken back
 *     SINGER 24M NATIONS PAY                          125,260.00 Dr     <- and charged again as the plan
 *     SINGER 24M NATIONS PAY INST 1 - REM BAL - ... <1/24>  5,219.17 Dr  <- the first instalment (the plan line, read by installmentInfo)
 * The first two cancel to the cent. Read one by one, the debit was filed as a 125,260 purchase on CC One-Time and the credit as a card PAYMENT of 125,260: the month's spending and the
 * month's payments were both 125,260 too big, while the card's balance (which they cancel in) was right. The money the owner really spends is the instalment, month by month, on the plan.
 *
 * A pair is a conversion only on evidence, never on a coincidence:
 *   - one debit and one credit on a card, the same amount to the cent, the same words, on the same day (or a day apart: the posting date can move);
 *   - and the words say it is a plan ("24M NATIONS PAY", "EASY PAY", "INSTALMENT"), or the statement's own plan table lists a plan whose original amount is this amount.
 * Each debit takes at most one credit and each credit at most one debit. A refund of a plain purchase ("KEELLS" debit, "KEELLS" credit) has no plan wording and no plan table row: it stays a refund.
 *
 * Pure: no network, no clock, no storage.
 * ===========================================================================*/

export { conversionLegs, CONVERSION_WORDS } from './wealthflow-statement-router.js';
