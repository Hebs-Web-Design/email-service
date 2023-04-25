const urlfy = obj =>
    Object.keys(obj)
        .map(k => encodeURIComponent(k) + "=" + encodeURIComponent(obj[k]))
        .join("&");

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

function dataValid(config: EmailConfig, country: string, formData: FormData) {
    console.log(config)

    if (config.allowed_countries !== undefined) {
        if (!config.allowed_countries.includes(country)) {
            console.log(`The submission came from a country that was not allowed: ${country}`);
            return false
        }
    }

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
    console.log(defaultValidator)
    for (const field of config.fields) {
        const value = formData.get(field)
        const validator = config.validations[field] === undefined ? defaultValidator : config.validations[field]

        console.log({ field: field, value: value, validator: validator })
        if (!fieldValid(value, validator)) {
            console.log(`"${field}" was not valid in form sumbission`)
            return false
        }
    }

    console.log('Would have been valid but rejecting for testing')
    return false
}

function fieldValid(value: string, validation: string | string[]) {
    switch (typeof validation) {
        case 'string':
            switch (validation) {
                case 'blank':
                    return value === ''
                case 'email':
                    let email_regex = /^(([^<>()[\]\\.,;:\s@\"]+(\.[^<>()[\]\\.,;:\s@\"]+)*)|(\".+\"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/
                    return email_regex.test(value)
                case 'notblank':
                    return value !== ''
                case 'phone':
                    // TODO: add proper validation of phone
                    return value !== ''
            }
            break
        case 'object':
            return validation.includes(value)

    }
    return false
}

function generateUserData(config: EmailConfig, formData: FormData) {
    return generateData(config, formData, true)
}

function generateAdminData(config: EmailConfig, formData: FormData) {
    return generateData(config, formData, false)
}

function generateData(config: EmailConfig, formData: FormData, user: Boolean = false) {
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

    const data = {
        to: to,
        from: from,
        subject: subject,
        template: template,
        't:variables': JSON.stringify(variables),
        'h:Reply-To': replyTo,
    };

    return data;
}

async function mailgunSend(config: EmailConfig, data) {
    const opts = {
        method: "POST",
        headers: {
            Authorization: "Basic " + btoa("api:" + config.mailgun_key),
            "Content-Type": "application/x-www-form-urlencoded",
            "Content-Length": Object.keys(data).length.toString()
        },
        body: urlfy(data)
    }

    return await fetch(`https://api.mailgun.net/v3/${config.mailgun_domain}/messages`, opts)
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

export async function HandleOptions(context) {
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


export async function HandlePost(context) {
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

    // grab country from headers
    let country = context.request.headers.get('cf-ipcountry')

    // validate data
    if (!dataValid(config, country, formData)) {
        let message = `Data validation failed`
        console.log(message)
        return JSONResponse(message, 400)
    }

    // Send user email
    try {
        await mailgunSend(config, generateUserData(config, formData))
    } catch (err) {
        let message = `There was a problem sending user email: ${err}`
        console.log(message)
        return JSONResponse(message, 500)
    }

    // Send admin email
    try {
        await mailgunSend(config, generateAdminData(config, formData))
    } catch (err) {
        let message = `There was a problem sending admin email: ${err}`
        console.log(message)
        return JSONResponse(message, 500)
    }

    // save to KV
    try {
        // add ip and county to formdata
        formData.append('ip', context.request.headers.get('cf-connecting-ip'))
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

    return JSONResponse(`Form submission OK`, 200)
}
