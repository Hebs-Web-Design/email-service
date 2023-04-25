# email-service

This is a module for use in a Cloudflare Pages Function to handle a form submission and send it via Mailgun.

## Usage

### Set up Mailgun

You will need to set up a verified domain in Mailgun and create a sending API key.

### Set up your Function

```ts
import { HandleOptions, HandlePost } from 'hebs-web-design/email-service'

interface Env {
    KV: KVNamespace
    EMAIL_CONFIG: string
    PROJECT_NAME: string
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    return await HandlePost(context)
}

export const onRequestOptions: PagesFunction = async (context) => {
    return await HandleOptions(context)
}
```

### Set up the environment

Configured the following environment variables in your Pages project:

* EMAIL_CONFIG - The name of the "config" to use (or could be hard coded in your function)
* PROJECT_NAME - The project name of your Pages project. This is used to reject access to the "bare" `*.pages.dev` domain.

### Set up the KV binding

The binding is expected to be called `KV`.

### Set up your config

This is created in your KV and named as per the `EMAIL_CONFIG` setting:

```json
{
    "prefix": "prefix for saving submissions to KV",
    "from": "from address for emails",
    "org": "org name",
    "admin_email": "email to send submissions to",
    "mailgun_domain": "your mailgun domain",
    "mailgun_key": "your mailgun api key",
    "honeypot": "a honeypot field that is expected to exist but be blank",
    "allowed_countries": ["an", "array", "of", "allowed", "country", "codes"],
    "fields": ["an", "array", "of", "fields", "in", "your", "form"],
    "admin_template": {
        "name": "mailgun template for emails to the admin",
        "subject": "subject for emails to the admin"
    },
    "user_template": {
        "name": "mailgun template for emails to the user",
        "subject": "subject for emails to the user"
    }
}
```
