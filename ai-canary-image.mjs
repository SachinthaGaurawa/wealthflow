/* =============================================================================
 * ai-canary-image.mjs — the one picture the vision canary shows every provider
 * -----------------------------------------------------------------------------
 * A 300x120 JPEG (about 5 KB) of a made-up till receipt: "ACME MART", a receipt number and date, and "TOTAL 1250.00". It carries nothing of the
 * owner's. A provider that can read images answers vendor ACME and amount 1250; one that cannot (a model that does not take images, a retired
 * model, a request shape the provider refuses) says so in its error. Rendered once from a script, stored as data so the canary needs no image
 * library at runtime. JPEG, not PNG: the board labels every image `image/jpeg`, as the app's own scans are.
 * ===========================================================================*/

export const CANARY_IMAGE_B64 =
    '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' +
    'tTFKeVTveA0PyTkAju6dUG5cq2aCopKSlEftFU5wa6QEtY1oy4kAjPcMZHVftsrZal1TBUtY2opZeW/gzwuBAIcAemQei0bxC2rl' +
    'oK00801K0SRzRiNwfwPbjPDgO6gfHdfdmpJB9oThstK2pe1sIIw9rGMDQcOBwduhHzQVaiZlPTyzyfciYXu+QGSpNNc60Ot8lbHA' +
    'ILhswMBDonFpc0Ek+9kA9w3W7NRSSWuppH1Us7po3sEkoaCMjH8IA/RRKSjM81tY2ingmikZLWPe1wbxRxlgAJ2Oc/w9yCrWVtZT' +
    '3iig4YPZqmRzOhL9mF2c7Abj4qmod4nAvNtIgqntppXOldHTSPABjIG4aQdyOittcHNDhnBGdxg/kg/UREBERAREQEREBFoVMt3b' +
    'O4UlDQywjHC+Wsexx23y0ROA3+JWPn37y22+oSfRQU0Uzn37y22+oSfRTn37y22+oSfRQU0Uzn37y22+oSfRTn37y22+oSfRQU0U' +
    'zn37y22+oSfRTn37y22+oSfRQU0Uzn37y22+oSfRTn37y22+oSfRQU0Uzn37y22+oSfRTn37y22+oSfRQU0Uzn37y22+oSfRTn37' +
    'y22+oSfRQU0Uzn37y22+oSfRTn37y22+oSfRQU0Uzn37y22+oSfRTn37y22+oSfRQU0Uzn37y22+oSfRTn37y22+oSfRQU0Uzn37' +
    'y22+oSfRTn37y22+oSfRQU0Uzn37y22+oSfRTn37y22+oSfRQU0Uzn37y22+oSfRTn37y22+oSfRQU0Uzn37y22+oSfRTn37y22+' +
    'oSfRQU0Uzn37y22+oSfRTn37y22+oSfRQU0Uzn37y22+oSfRTn37y22+oSfRQU0Uzn37y22+oSfRW5Rvq3xE10EEMnFs2GYyAjxy' +
    'Wt367YQZ0REBERARc3qWj1ZUVsb9O3OkpKYRYeyZoJL8nf7ju7HeuN0zdNd6miqJKC90sYgLQ7nQsGc56YjPgg9WRchrTU9Zp63U' +
    'VLTNZNdKsBoJGQCMAnG2ck7KNJqLVWlrpRN1RJT1NHVnBdG0Ax9M7gDcZHjnxQekIuM1WzWNPLXXG1XakgtsEPNETmNL8NZl3Vh6' +
    'kHvUfS9VrrUFLHcIb1SClbNwPZJEwOIGM9Iz3HxQeloue11eZrHpmaqpJBHUve2OFxAOHE5Ox26AqV2eagud0luNDe5uZV0zmluW' +
    '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';
export const CANARY_IMAGE_TRUTH = Object.freeze({ vendor: 'ACME MART', amount: 1250 });
