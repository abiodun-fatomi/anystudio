-- A sign-in completed on the marketing host is redeemed on the app host.
ALTER TYPE "TokenPurpose" ADD VALUE 'SESSION_HANDOFF';
