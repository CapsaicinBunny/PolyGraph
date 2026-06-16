; JSON / JSONC pack. A config file has no code relationships, so we surface its
; top-level keys as property nodes (so e.g. package.json shows scripts, deps, …).
(document
  (object
    (pair key: (string (string_content) @name)))) @definition.property
