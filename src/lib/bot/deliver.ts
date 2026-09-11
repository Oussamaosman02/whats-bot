/** Outbound helpers shared by the command handler and the schedulers. */
import { env } from "../env";
import { whatsapp } from "../whatsapp/client";
import { phoneFromJid } from "../whatsapp/jid";
import { zernio } from "../zernio/client";

/** Sends a DM to a user, via Baileys or Zernio depending on DM_TRANSPORT. */
export async function sendDm(userJid: string, text: string, reqId: string) {
  const phone = phoneFromJid(userJid);
  if (env().DM_TRANSPORT === "zernio" && phone) {
    await zernio.sendToPhone({ phone, text, reqId });
    return;
  }
  await whatsapp.sendText(userJid, text);
}
