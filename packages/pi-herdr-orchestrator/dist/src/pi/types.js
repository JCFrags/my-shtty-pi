export function modelChoiceFromPi(model) {
    const choice = {
        provider: model.provider,
        id: model.id,
        name: typeof model.name === "string" && model.name.length > 0
            ? model.name
            : model.id,
    };
    if (Number.isSafeInteger(model.contextWindow) &&
        model.contextWindow > 0)
        choice.contextWindow = model.contextWindow;
    return choice;
}
