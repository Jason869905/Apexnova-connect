import type { DeviceVerificationPrompt } from "./types.js";

/**
 * The one link a user has to open to finish a device login.
 *
 * RFC 8628 leaves `verification_uri_complete` optional, so a prompt can arrive
 * with only the bare page and the code beside it -- which costs the user a
 * copy-paste between two places. Hub carries the code in the URL, and the query
 * parameter it uses (`user_code`, the name in its own device-code response) is
 * the same one the page reads when the server omits the complete URI, so
 * building it here keeps the login a single click either way. The code stays in
 * the prompt: the page still asks the user to confirm it matches.
 */
export function deviceVerificationUrl(
  prompt: Pick<
    DeviceVerificationPrompt,
    "userCode" | "verificationUri" | "verificationUriComplete"
  >,
): string {
  if (prompt.verificationUriComplete !== undefined) return prompt.verificationUriComplete;
  try {
    const url = new URL(prompt.verificationUri);
    url.searchParams.set("user_code", prompt.userCode);
    return url.toString();
  } catch {
    return prompt.verificationUri;
  }
}
