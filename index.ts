type EmailConfig = {
    prefix: string
    from: string
    org: string
    admin_email: string
    mailgun_domain: string
    mailgun_key: string
    honeypot: string
    allowed_countries: string[]
    fields: string[]
    admin_template: EmailTemplate
    user_template: EmailTemplate
    validations: EmailFieldValidatons
};

type EmailTemplate = {
    name: string
    subject: string
}

type EmailFieldValidatons = {
    [index: string]: string | string[]
}

type MailgunResponse = {
    message: string
    id: string
}

interface Env {
	KV: KVNamespace;
    PROJECT_NAME: string
    TURNSTILE_SECRET_KEY: string
    EMAIL_CONFIG: string
}

function dataValid(config: EmailConfig, country: string, formData: FormData) {
    // check country is valid
    if (config.allowed_countries !== undefined) {
        if (!config.allowed_countries.includes(country)) {
            console.log(`The submission came from a country that was not allowed: ${country}`);
            return false
        }
    }

    // check on honeypot
    if (config.honeypot !== undefined) {
        // make sure honeypot exists
        if (!formData.has(config.honeypot)) {
            console.log(`Honeypot field was missing in form sumbission`);
            return false
        }

        // make sure honepot is blank
        if (formData.get(config.honeypot) !== '') {
            console.log(`Honeypot field set in form sumbission`);
            return false
        }
    }

    // make sure all fields are valid using configured validators
    let defaultValidator = config.validations['*'] !== undefined ? config.validations['*'] : 'notblank'
    for (const field of config.fields) {
        const value = formData.get(field)
        const validator = config.validations[field] === undefined ? defaultValidator : config.validations[field]

        if (!fieldValid(value, validator)) {
            console.log(`"${field}" was not valid in form sumbission`)
            return false
        }
    }

    // if we get here all checks have passed
    return true
}

function fieldValid(value: string, validation: string | string[]) {
    switch (typeof validation) {
        case 'string':
            if (validation.startsWith('regex:')) {
                const re = new RegExp(validation.slice('regex:'.length))
                return re.test(value)
            } else {
                switch (validation) {
                    case 'blank':
                        return value === ''
                    case 'email':
                        // check for valid email via regex
                        const em = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/
                        return em.test(value)
                    case 'notblank':
                        // ensure not blank and also not null or undefined
                        return value !== '' && value !== null && value != undefined
                    case 'phone':
                        // test phone via regex
                        const ph = /^[0-9]{4}[\- ][0-9]{3}[\- ][0-9]{3}$|^[0-9]{10}$|^\+[1-9][0-9]{10}$/
                        return ph.test(value)
                }
            }
            break
        case 'object':
            return validation.includes(value)

    }
    return false
}

async function mailgunSend(config: EmailConfig, formData: FormData, user: Boolean = false):Promise<Response> {
    const org = config.org
    const to = user ? `${formData.get('name')} <${formData.get('email')}>` : config.admin_email
    const from = `${config.org} <${config.from}>`
    const template = user ? config.user_template.name : config.admin_template.name
    const subject = user ? config.user_template.subject : config.admin_template.subject
    const replyTo = user ? config.admin_email : formData.get('email')

    let variables = {
        org
    }
    for (const field of config.fields) {
        variables[field] = formData.get(field)
    }

    // add data to body
    const body = new URLSearchParams()
    body.append('from', from)
    body.append('to', to)
    body.append('subject', subject)
    body.append('template', template)
    body.append('t:variables', JSON.stringify(variables))
    body.append('h:Reply-To', replyTo)
    
    // create request
    const request = {
        method: "POST",
        headers: {
            Authorization: "Basic " + btoa("api:" + config.mailgun_key),
            "Content-Type": "application/x-www-form-urlencoded"
        },
        body: body.toString()
    }
    
    // perform request
    return await fetch(`https://api.mailgun.net/v3/${config.mailgun_domain}/messages`, request)
}

// Helper function to return JSON response
const JSONResponse = (message, status = 200) => {
    let headers = {
        headers: {
            'Content-Type': 'application/json;charset=UTF-8',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        },

        status: status
    };

    let response = {
        message: message
    };

    return new Response(JSON.stringify(response), headers);
};

export async function HandleOptions(context: EventContext<Env, null, null>) {
    const request = context.request

    // CORS request
    if (request.headers.get('Origin') !== null &&
        request.headers.get('Access-Control-Request-Method') !== null &&
        request.headers.get('Access-Control-Request-Headers') !== null) {
        return new Response(null, {
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type'
            }
        })
    }

    // standard OPTIONS request
    return new Response(null, {
        headers: {
            Allow: 'POST, OPTIONS'
        }
    });
}

export async function HandlePost(context: EventContext<Env, null, null>) {
    // reject for pages.dev.domain
    if (context.request.headers.get('host') === `${context.env.PROJECT_NAME}.pages.dev`) {
        return JSONResponse('Not Found', 404)
    }

    console.log(`form sumbission`)

    let formData: FormData

    // grab form data
    try {
        formData = await context.request.formData()
    } catch (err) {
        let message = `There was a problem getting form data: ${err}`
        console.log(message)
        return JSONResponse(message, 500)
    }

    // get ip and country for later
    const ip = context.request.headers.get('cf-connecting-ip')
    const country = context.request.headers.get('cf-ipcountry')

    // verify turnstyle
    if (context.env.TURNSTILE_SECRET_KEY !== undefined) {
        const token = formData.get('cf-turnstile-response')
        const outcome = await turnstileOutcome(context.env.TURNSTILE_SECRET_KEY, token, ip)

        if (!outcome.success) {
            let message = `Invalid turnstile response`
            console.log(message, outcome["error-codes"])
            return JSONResponse(message, 400)
        }
   }

    // grab config
    let config: EmailConfig
    let configName = context.env.EMAIL_CONFIG
    try {
        config = await context.env.KV.get(configName, { type: 'json' });
    } catch (err) {
        let message = `There was a problem getting config ("${configName}"): ${err}`
        console.log(message)
        return JSONResponse(message, 500)
    }

    // set default validation if none exists
    if (config.validations === undefined) {
        config.validations = {
            '*': 'notblank',
            'email': 'email'
        }
    }

    // set default valdator if not set
    if (config.validations['*'] === undefined) {
        config.validations['*'] = 'notblank'
    }

    // key to save form submission
    const prefix = config.prefix !== undefined ? config.prefix : 'submission'
    const key = `${prefix}:${new Date().toISOString()}`

    // validate data
    if (!dataValid(config, country, formData)) {
        let message = `Data validation failed`
        console.log(message)
        return JSONResponse(message, 400)
    }

    // save to KV first
    try {
        // add ip and county to formdata
        formData.append('ip', ip)
        formData.append('country', country)

        // add threat_score header if it exists
        let threat_score = context.request.headers.get('x-threat-score')
        if (threat_score !== null) {
            formData.append('threat_score', threat_score)
        }

        // save
        await context.env.KV.put(key, JSON.stringify(Object.fromEntries(formData)))
    } catch (err) {
        let message = `There was a problem saving the form data: ${err}`
        console.log(message)
        return JSONResponse(message, 500)
    }

    // Send user email
    try {
        const response = await mailgunSend(config, formData, true)

        if (!response.ok) {
            const json:MailgunResponse = await response.json()
            throw json.message ?? 'unknown mailgun api error'
        }
    } catch (err) {
        let message = `There was a problem sending user email: ${err}`
        console.log(message)
        return JSONResponse(message, 500)
    }

    // Send admin email
    try {
        const response = await mailgunSend(config, formData, false)

        if (!response.ok) {
            const json:MailgunResponse = await response.json()
            throw json.message ?? 'unknown mailgun api error'
        }
    } catch (err) {
        let message = `There was a problem sending admin email: ${err}`
        console.log(message)
        return JSONResponse(message, 500)
    }

    return JSONResponse(`Form submission OK`, 200)
}

type TurnstileResponse = {
    success: boolean
    challenge_ts: string
    hostname: string
    'error-codes': string[]
    action: string
    cdata: String
}

async function turnstileOutcome(secret: string, token: string, ip: string) {
    let formData = new FormData();
	formData.append('secret', secret);
	formData.append('response', token);
	formData.append('remoteip', ip);

    const url = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
	const result = await fetch(url, {
		body: formData,
		method: 'POST',
	});

    const outcome:TurnstileResponse = await result.json();

    return outcome;
}