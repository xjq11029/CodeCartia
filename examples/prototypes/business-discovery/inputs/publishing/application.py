import framework as fw


def stamp(entry):
    entry.revision = 1


def inspect_lock(person, document):
    if document.locked:
        raise RuntimeError("locked")


def publish(editor, article, callback):
    fw.enforce(editor, article, editor.level >= 2 and editor.team == article.team)
    fw.validate(article, article.ready)
    article.phase = "released"
    stamp(article)
    callback(article)
    return article


def withdraw(editor, article):
    fw.enforce(editor, article, editor.level >= 3)
    inspect_lock(editor, article)
    article.phase = "withdrawn"
    stamp(article)
    return article


fw.register("PUT", "/articles/release", publish)
fw.register("DELETE", "/articles/release", withdraw)
