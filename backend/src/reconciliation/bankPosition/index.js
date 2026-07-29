'use strict';

const { getLatestVerifiedBankPosition, isSupportedBank, ADAPTERS } = require('./bankPositionService');
const { getConfirmedFundingMutations, getConfirmedIncomingNotYetReflected } = require('./fundingDetectionService');

module.exports = {
  getLatestVerifiedBankPosition,
  getConfirmedFundingMutations,
  getConfirmedIncomingNotYetReflected,
  isSupportedBank,
  ADAPTERS,
};
