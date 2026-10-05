// A SMALL ARGUMENT CHECK, because the runtime's schema subset does not refuse an unknown key by itself.
//
// Measured, in the plugin this was extracted from: a caller passed an argument the row did not declare and the answer
// was about the missing parameter rather than about the call, which reads as a bug in the tool. So an unknown key is
// NAMED, and so is a wrong type -- the same rule as everywhere else here: refuse by name rather than guess.

export function checkAgainst(schema, args, toolName) {
    const properties = schema?.properties ?? {}
    for (const key of Object.keys(args)) {
        if (properties[key] === undefined) throw new Error(`${toolName}: unknown parameter \`${key}\``)
    }
    for (const [key, spec] of Object.entries(properties)) {
        const value = args[key]
        if (value === undefined) continue
        if (spec.type === 'number' && (typeof value !== 'number' || Number.isNaN(value))) throw new Error(`${toolName}: \`${key}\` must be a number`)
        if (spec.type === 'string' && typeof value !== 'string') throw new Error(`${toolName}: \`${key}\` must be a string`)
        if (spec.type === 'array' && !Array.isArray(value)) throw new Error(`${toolName}: \`${key}\` must be an array`)
        if (spec.enum !== undefined && !spec.enum.includes(value)) throw new Error(`${toolName}: \`${key}\` must be one of ${spec.enum.join(', ')}`)
    }
}
