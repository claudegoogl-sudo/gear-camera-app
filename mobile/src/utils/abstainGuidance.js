/**
 * What to tell the user when the counter gives no number.
 * v2 reasons say what is wrong with the photo; older builds only knew "dense chainring".
 */
const V2 = {
  'v2-cut-off': {
    body: 'Part of the gear is outside the picture.',
    hint: 'Move back until the whole gear, with all its teeth, is inside the frame.',
  },
  'v2-no-gear': {
    body: 'No gear was found in the picture.',
    hint: 'Put the gear on a plain, bright surface (a sheet of paper) and keep other objects out of the frame.',
  },
  'v2-not-teeth': {
    body: 'The outline that was found does not look like gear teeth.',
    hint: 'Make sure the outer teeth are fully visible and stand out from the background.',
  },
  'v2-unclear': {
    body: 'The teeth are not clear enough to count.',
    hint: 'Use even light without hard shadows, hold the phone flat above the gear, and hold steady.',
  },
};

export function abstainGuidance(abstainReason) {
  return V2[abstainReason] || null;
}
