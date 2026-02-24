import { cleanEnv, num, port, str, url } from "envalid";

export const env = cleanEnv(process.env, {
  PORT: port({ default: 20261 }),
  HOST: str({ default: "0.0.0.0", devDefault: "localhost" }),
  PAYMENT_CONSUME_PRN_URL: url({
    default: "https://api-internal.niradev1.idencode.link/v1/payment/consumePrn"
  }),
  PAYMENT_CHECK_PRN_STATUS_URL: url({
    default:
      "https://api-internal.niradev1.idencode.link/v1/payment/checkPrnStatus"
  }),
  PAYMENT_API_TIMEOUT_MS: num({ default: 15000 })
});
