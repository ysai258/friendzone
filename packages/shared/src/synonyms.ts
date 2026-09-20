/**
 * Answers that mean the same thing at a table.
 *
 * Mind Meld scores you for agreeing with someone, and "phone" and "mobile" are
 * agreement — a player who typed one and lost points to a player who typed the
 * other has been cheated by the software, not out-guessed. The clustering key
 * therefore folds each group below to its first entry.
 *
 * This is editorial data, like the question datasets, and the rules it was
 * written to are:
 *
 * - **Only true equivalence.** `tea`/`chai` yes; `tea`/`coffee` no. If a group
 *   would merge two answers a player could have deliberately chosen between,
 *   it does not belong here.
 * - **No ambiguous words.** Indian English uses "picture" for both a photo and
 *   a film, and "hotel" for both a place to sleep and a place to eat. Mapping
 *   either would merge answers that are genuinely different, so both are left
 *   alone — an unmerged pair costs one round, a wrongly merged pair is a bug
 *   nobody can see.
 * - **Spellings count.** Half the value here is `biryani`/`biriyani` and
 *   `chapati`/`chapathi`, which are the same word typed by two people.
 * - **One group per word.** A variant listed twice would make the fold depend
 *   on which group was read first; a test enforces it.
 *
 * Plurals, gerunds and `-y`/`-ie` endings are already handled by the stemmer,
 * so `phones`, `mobiles` and `idly` need no entry.
 */
export const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  // --- Things in a pocket, a room, a house ---------------------------------
  ['phone', 'mobile', 'cellphone', 'cell phone', 'mobile phone', 'smartphone', 'smart phone', 'telephone', 'handset'],
  ['tv', 'television', 'telly', 'idiot box'],
  ['fridge', 'refrigerator'],
  ['ac', 'air conditioner', 'air conditioning', 'aircon'],
  ['computer', 'pc', 'desktop'],
  ['earphones', 'headphones', 'earphone', 'headphone', 'earbuds', 'headset'],
  ['charger', 'phone charger'],
  ['remote', 'remote control', 'tv remote'],
  ['glasses', 'specs', 'spectacles', 'eyeglasses'],
  ['watch', 'wristwatch', 'hand watch', 'wrist watch'],
  ['wallet', 'purse'],
  ['torch', 'flashlight'],
  ['washing machine', 'washer'],
  ['alarm', 'alarm clock'],
  ['toothbrush', 'tooth brush'],
  ['bathroom', 'toilet', 'washroom', 'restroom', 'bath room', 'loo'],
  ['bedroom', 'bed room'],
  ['sofa', 'couch'],
  ['lift', 'elevator'],

  // --- Getting somewhere ----------------------------------------------------
  ['bike', 'motorcycle', 'motorbike', 'two wheeler', 'twowheeler'],
  ['car', 'automobile', 'four wheeler'],
  ['auto', 'rickshaw', 'auto rickshaw', 'autorickshaw'],
  ['cab', 'taxi'],
  ['train', 'railway', 'rail'],
  ['plane', 'airplane', 'aeroplane', 'flight', 'aircraft'],
  ['petrol', 'gas', 'fuel'],
  ['traffic', 'traffic jam'],

  // --- People ---------------------------------------------------------------
  ['mom', 'mother', 'mummy', 'mum', 'amma', 'mumma'],
  ['dad', 'father', 'papa', 'daddy', 'nanna', 'appa'],
  ['grandmother', 'grandma', 'ammamma', 'nanamma', 'granny'],
  ['grandfather', 'grandpa', 'tatayya', 'thatha', 'grandad'],
  ['friend', 'buddy', 'dost', 'bestie', 'best friend'],
  ['doctor', 'dr'],
  ['police', 'cop', 'policeman', 'police man'],
  ['neighbour', 'neighbor'],
  ['kid', 'child', 'kids'],

  // --- Food and drink -------------------------------------------------------
  ['tea', 'chai', 'chaa'],
  ['coffee', 'kaapi', 'filter coffee'],
  ['rice', 'annam', 'steamed rice'],
  ['curd', 'yogurt', 'yoghurt', 'dahi', 'perugu'],
  ['roti', 'chapati', 'chapathi', 'phulka'],
  ['biryani', 'biriyani', 'briyani', 'biriyaani'],
  ['dosa', 'dosai', 'dose', 'thosai'],
  ['sambar', 'sambhar', 'saambar'],
  ['icecream', 'ice cream'],
  ['chocolate', 'choco'],
  ['sweets', 'dessert', 'mithai'],
  ['snacks', 'munchies'],
  ['nonveg', 'non veg', 'non vegetarian'],
  ['veg', 'vegetarian'],
  ['juice', 'fruit juice'],
  ['soda', 'soft drink', 'cool drink', 'cold drink'],
  ['biscuit', 'cookie'],
  ['brinjal', 'eggplant', 'aubergine', 'baingan', 'vankaya'],
  ['ladiesfinger', 'ladies finger', 'okra', 'bhindi', 'bendakaya'],
  ['coriander', 'cilantro', 'kothimeera', 'dhaniya'],

  // --- Doing things ---------------------------------------------------------
  ['sleep', 'nap', 'snooze', 'siesta'],
  ['bath', 'shower', 'bathe'],
  ['money', 'cash', 'rupees', 'paisa', 'paise'],
  ['movie', 'film', 'cinema'],
  ['photo', 'pic', 'photograph'],
  ['holiday', 'vacation'],
  ['gift', 'present'],
  ['queue', 'line'],
  ['lecture', 'class'],

  // --- Spellings that are simply two spellings ------------------------------
  ['colour', 'color'],
  ['favourite', 'favorite'],
  ['grey', 'gray'],
  ['theatre', 'theater'],
  ['jewellery', 'jewelry'],
  ['practise', 'practice'],
  ['travelling', 'traveling'],
  ['cancelled', 'canceled'],
  ['metre', 'meter'],
  ['pyjamas', 'pajamas'],
]
