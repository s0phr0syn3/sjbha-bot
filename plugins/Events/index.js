/**
 *  Use this as the base template for a new command
 * 
 */

import deepmerge from 'deepmerge'
import './Schema'
import Event from './Event'
import baseConfig from './event.config'
import utils from './utils'
import Archive from './archive'
import compact from './compact'
import path from 'path'
import router from './ui/router'
import express from 'express'

export default function(bastion, opt={}) {
    const config = deepmerge(baseConfig, opt)
    const archive = Archive(bastion, config)

    const cmd = bastion.command(config.command)
    const log = bastion.Logger("Events").log
    const help = `Template: date and name are required` +
        bastion.helpers.code(
            `${cmd} date: 12/20 6:00pm\n` +
            `| name: (${config.name}-name-here)\n` +
            '| description:\n' +
            '| location:\n' +
            '| url:\n' +
            '| image:\n' +
            '| type: (choices: event, drinks, food, or active)'
        ) +
        `\`${cmd} cancel\` to cancel\n`+
        `\`${cmd} edit\` to edit\n` +
        `\`${cmd} mention\` to mention` +
        `\`${cmd} transfer\` to make someone else owner`
    
    const q = new bastion.Queries('Meetup')

    bastion.on('schedule-hourly', async function() {
        log("Updating compact events on schedule")
        const events = await q.getAll()
        compact.update(bastion, config, events.map( e => new Event(e, config)))
    })

    // Set up calendar UI
    bastion.app.use('/calendar/public', express.static(path.join(__dirname, 'ui', 'public')))
    bastion.app.use('/calendar', router(bastion, config))

    return [

        // Create a meetup
        {
            // Command to start it
            command: config.command, 
            requires: ["Ask"],
            // Optional help string for `!command help`
            help,
            // Show help string with empty `!command` (in case parameters are required)
            helpOnEmpty: true,

            // Core of the command
            resolve: async function(context, message) {
                if (message === "cancel") return this.route('cancel')
                if (message === "mention") return this.route('mention')
                if (message === "edit") return this.route('edit')
                if (message === "transfer") return this.route('transfer')

                const opt = utils.getOptions(message.split("|").map(n=>n.trim()))
                if (!opt.date || !opt.name) return log("Missing required fields (date, name)")

                this.type()
                try {
                    const event = new Event({
                        date: opt.date,
                        info: opt.name,
                        options: opt,
                        userID: context.userID,
                        username: context.user,
                        sourceChannelID: context.channelID
                    }, config)
        
                    log("Validating meetup")
                    let error = event.validate()
                    if (error) return error
        
                    // Post the event in event announcements
                    log("Announcing Event")
                    await event.announce(bastion.bot)
        
                    log("Saving to database")
                    q.createOrUpdate({ id: event.id()}, event.toJSON())

                    return `${config.name} added: \`${event.info()}\` Find it in <#${config.announcementChannel}>!`
                    // MeetupsPlaintext.update({bot})
                } catch (e) {
                    console.error(e)
                }
            }
        },

        // Cancel a meetup
        {
            // Command to start it
            action: `${config.command}:cancel`, 

            // Core of the command
            resolve: async function(context, message) {
                // Step 1: get all events
                let events = await q.find({userID: context.userID})
                events = events.map( e => new Event(e, config))
                if (events.length === 0) return log(`You don't have any active ${config.name}s to cancel!`)

                const event = await this.chooseEvent(context, events)
                if (!event) return log("(cancel) Failed to get event"), null

                log("Removing event", event.id())
                await event.cancel(bastion.bot)
                await q.remove({id: event.id()})

                bastion.emit("events-update")

                return "Canceled `"+event.info_str()+"`"
            },

            methods: {
                chooseEvent: async function(context, events) {
                    const event_list = events.map( (e, i) => `${i}: ${e.info()}`).join("\n")

                    const index = await bastion.Ask(`Which ${config.name} do you want to cancel?\n${bastion.helpers.code(event_list)}`, 
                        context, 
                        (val) => {
                            if (isNaN(parseInt(val))) return `'${val}' is not a valid option; Please pick an option from 0-${events.length}`
                            if (val < 0 || val >= events.length) return `'${val}' is not a valid option; Please pick an option from 0-${events.length}`
                        }, 2)

                    // Step 3: Cancel the meetup
                    return events[index]
                }
            }
        },
        
        // Edit a meetup
        {
            // Command to start it
            action: `${config.command}:edit`, 

            // Core of the command
            resolve: async function(context, message) {
                // Step 1: get all events
                let events = await q.find({userID: context.userID})
                events = events.map( e => new Event(e, config))
                if (events.length === 0) return log(`You don't have any active ${config.name}s to edit!`)

                const event = await this.chooseEvent(context, events)
                if (!event) return log("(edit) Failed to get event"), null

                const update = await this.getUpdated(context, event)
                if (!update) return log("(edit) Failed to get update string"), null

                log("Editing event", event.id())
                event.update(update)
                event.updateAnnouncement(bastion.bot)

                log("Saving to database")
                q.update({ id: event.id() }, event.toJSON())

                log("Emitting events-update")
                bastion.emit("events-update")
                return `You got it! Updated to \`${event.info()}\``
            },

            methods: {
                chooseEvent: async function(context, events) {
                    const event_list = events.map( (e, i) => `${i}: ${e.info()}`).join("\n")

                    const index = await bastion.Ask(`Which ${config.name} do you want to edit?\n${bastion.helpers.code(event_list)}`, 
                        context, 
                        val => {
                            if (isNaN(parseInt(val))) return `'${val}' is not a valid option; Please pick an option from 0-${events.length}`
                            if (val < 0 || val >= events.length) return `'${val}' is not a valid option; Please pick an option from 0-${events.length}`
                        }, 2)

                    // Step 3: Cancel the event
                    return events[index]
                },
                getUpdated: async function(context, event) {
                    const val = await bastion.Ask(
                        `Ok, editing '${event.info_str()}' - What do you want to change it to?\nYou can copy and paste this:\n${bastion.helpers.code(event.getMeetupString())}`,
                        context, 
                        val => {
                            const obj = utils.getOptions(val.split("|").map(n => n.trim()))
                            return event.validate(obj)
                        }, 2)

                    return (val) ? utils.getOptions(val.split("|").map(n => n.trim())) : null
                }
            }
        },   
        
        // Mention everyone who's RSVP'd
        {
            action: `${config.command}:mention`, 

            // Core of the command
            resolve: async function(context, message) {
                if (!config.allowMention) return

                // Step 1: get all events
                let events = await q.getAll()
                events = events.map( e => new Event(e, config))
                if (events.length === 0) return `There are no active ${config.name}s`

                const event = await this.chooseEvent(context, events)
                if (!event) return

                this.type()
                const update = await bastion.Ask(`What do you want to let everyone know?`, context)
                if (!update) return

                this.type()
                const reactions = await event.getReactions(bastion.bot)
                const mentions = Array.from(
                        new Set([
                            ...reactions.yes, 
                            ...reactions.maybe
                        ].map(n => bastion.helpers.toMention(n.id))
                    )).join(" ")

                return `**[Update] ${event.info_str()}**\n\n${update} *-${context.user}*\n\n${mentions}`
            },

            methods: {
                chooseEvent: async function(context, events) {
                    const event_list = events.map( (e, i) => `${i}: ${e.info()}`).join("\n")

                    const index = await bastion.Ask(`Which ${config.name} do you want to mention?\n${bastion.helpers.code(event_list)}`, 
                        context, 
                        (val) => {
                            if (isNaN(parseInt(val))) return `'${val}' is not a valid option; Please pick an option from 0-${events.length}`
                            if (val < 0 || val >= events.length) return `'${val}' is not a valid option; Please pick an option from 0-${events.length}`
                        }, 2)

                    // Step 3: Cancel the meetup
                    return events[index]
                },
                getUpdateString: async function(context) {
                    return bastion.Ask(`What `, context)
                }
            }
        },

        {
            command: "archive",
            restrict: ["admin"],
            resolve: async () => {
                archive.archiveMeetups(0)
            }
        },

        // List all meetups
        {
            command: `${config.command}s`,

            resolve: async function(context) {
                const list = await q.getAll()
                const events = list.map( n => new Event(n, config))
                    .sort(utils.eventSort)

                if (!events.length) return "No scheduled meetups"

                const sevenDays = new Date()
                sevenDays.setDate( sevenDays.getDate() + 7)

                const output = events.filter(n => {
                        return n.date_moment().toDate() < sevenDays
                    }).map(this.outputString)
                    .join("\n\n")

                return output + `\n\n*Only meetups in next 7 days are shown, to see more check out <#${config.announcementChannel}> or <#${config.compactChannel}>*`
            },

            methods: {
                outputString(event) {
                    const title = event.info_str(),
                        fromNow = event.date_moment().fromNow(),
                        date = event.date_moment().format("dddd, MMMM D @ h:mma")

                    return `**# ${title}**\n${fromNow} - ${date}`
                }
            }
        },

        // Admin commands for compact channel
        {
            command: "init-compact",
            restrict: ["admin"],
            resolve: async function(context) {
                const today = await bastion.bot.sendMessage({
                    to: config.compactChannel, 
                    message: "Today"
                })
                const week0 = await bastion.bot.sendMessage({
                    to: config.compactChannel, 
                    message: "This Week"
                })
                const week1 = await bastion.bot.sendMessage({
                    to: config.compactChannel, 
                    message: "One Week"
                })
                const week2 = await bastion.bot.sendMessage({
                    to: config.compactChannel, 
                    message: "Two Weeks"
                })
                const week3 = await bastion.bot.sendMessage({
                    to: config.compactChannel, 
                    message: "Three Weeks"
                })
                const later = await bastion.bot.sendMessage({
                    to: config.compactChannel, 
                    message: "Later"
                })

                const obj = {
                    todayId: today.id,
                    thisWeekId: week0.id,
                    nextWeekId: week1.id,
                    twoWeeksId: week2.id,
                    threeWeeksId: week3.id,
                    laterId: later.id
                }
                this.send(context.channelID, JSON.stringify(obj))
            }
        },

        {
            command: "compact-update",
            restrict: ["admin"],
            resolve: async function(context) {
                const events = await q.getAll()
                compact.update(bastion, config, events.map( e => new Event(e, config)))
            }
        },

                // Cancel a meetup
                {
                    // Command to start it
                    action: `${config.command}:transfer`, 
        
                    // Core of the command
                    resolve: async function(context, message) {
                        // Step 1: get all events
                        let events = await q.find({userID: context.userID})
                        events = events.map( e => new Event(e, config))
                        if (events.length === 0) return log(`You don't have any active ${config.name}s to transfer!`)
        
                        const event = await this.chooseEvent(context, events)
                        if (!event) return log("(transfer) Failed to get event"), null
        
                        const reactions = await event.getReactions(bastion.bot)
                        const owners = reactions.yes.filter( u => u.id !== context.userID)
                        if (!owners.length) return "Nobody else has RSVP'd for the event. To transfer, the new owner should be RSVP'd"

                        const newOwner = await this.chooseOwner(context, owners)

                        event.setOwner(newOwner.id, newOwner.username)
                        event.updateAnnouncement(bastion.bot)

                        log("Saving to database")
                        console.log(event.toJSON())
                        q.update({ id: event.id() }, event.toJSON())

                        bastion.emit("events-update")
                        return `Alright, ${bastion.helpers.toMention(newOwner.id)} is now in charge of '${event.info()}'`
                    },
        
                    methods: {
                        chooseEvent: async function(context, events) {
                            const event_list = events.map( (e, i) => `${i}: ${e.info()}`).join("\n")
        
                            const index = await bastion.Ask(`Which ${config.name} do you want to transfer?\n${bastion.helpers.code(event_list)}`, 
                                context, 
                                (val) => {
                                    if (isNaN(parseInt(val))) return `'${val}' is not a valid option; Please pick an option from 0-${events.length}`
                                    if (val < 0 || val >= events.length) return `'${val}' is not a valid option; Please pick an option from 0-${events.length}`
                                }, 2)
        
                            return events[index]
                        },
                        chooseOwner: async function(context, owners) {
                            const choice = owners.map( (u, i) => `${i}: ${u.username}`).join("\n")
                            
                            const index = await bastion.Ask(`Which user do you want to give ownership to?\n${bastion.helpers.code(choice)}`, 
                            context, 
                            (val) => {
                                if (isNaN(parseInt(val))) return `'${val}' is not a valid option; Please pick an option from 0-${events.length}`
                                if (val < 0 || val >= owners.length) return `'${val}' is not a valid option; Please pick an option from 0-${events.length}`
                            }, 2)

                            return owners[index]
                        }
                    }
                },
        
    ]
}