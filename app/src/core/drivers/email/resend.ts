import type { IEmailDriver } from "./index";

export type ResendEmailOptions = {
   apiKey: string;
   host?: string;
   from?: string;
};

export type ResendEmailSendOptions = {
   bcc?: string | string[];
   cc?: string | string[];
   reply_to?: string | string[];
   scheduled_at?: string;
   headers?: Record<string, string>;
   attachments?: {
      content: Buffer | string;
      filename: string;
      path: string;
      content_type: string;
   }[];
   tags?: {
      name: string;
      value: string;
   }[];
};

export type ResendEmailResponse = {
   id: string;
};

export const resendEmail = (
   config: ResendEmailOptions,
): IEmailDriver<ResendEmailResponse, ResendEmailSendOptions> => {
   const host = config.host ?? "https://api.resend.com/emails";
   const from = config.from ?? "Acme <onboarding@resend.dev>";
   return {
      send: async (
         to: string,
         subject: string,
         body: string | { text: string; html: string },
         options?: ResendEmailSendOptions,
      ) => {
         const payload: any = {
            from,
            to: [to],
            subject,
         };

         if (typeof body === "string") {
            payload.html = body;
         } else {
            payload.html = body.html;
            payload.text = body.text;
         }

         if (options?.bcc) {
            payload.bcc = options.bcc;
         }
         if (options?.cc) {
            payload.cc = options.cc;
         }
         if (options?.reply_to) {
            payload.reply_to = options.reply_to;
         }
         if (options?.scheduled_at) {
            payload.scheduled_at = options.scheduled_at;
         }
         if (options?.headers) {
            payload.headers = options.headers;
         }
         if (options?.attachments) {
            payload.attachments = options.attachments;
         }
         if (options?.tags) {
            payload.tags = options.tags;
         }

         const res = await fetch(host, {
            method: "POST",
            headers: {
               "Content-Type": "application/json",
               Authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify(payload),
         });

         if (!res.ok) {
            throw new Error(await res.text());
         }

         return (await res.json()) as ResendEmailResponse;
      },
   };
};
