on parseWhenOrDate(str)
  try
    if str is "" or str is missing value then return missing value
    set lower to str as string
    if lower is "today" then
      return current date
    else if lower is "tomorrow" then
      return (current date) + 1 * days
    end if
    set AppleScript's text item delimiters to "-"
    set parts to text items of str
    set AppleScript's text item delimiters to ""
    if (count of parts) is 3 then
      set d to current date
      set day of d to 1
      set year of d to (item 1 of parts as integer)
      set month of d to (item 2 of parts as integer)
      set day of d to (item 3 of parts as integer)
      set hours of d to 0
      set minutes of d to 0
      set seconds of d to 0
      return d
    end if
    return missing value
  on error
    return missing value
  end try
end parseWhenOrDate

on run argv
  if (count of argv) is 0 then return ""
  set todoTitle to item 1 of argv
  set todoNotes to ""
  if (count of argv) is greater than or equal to 2 then
    set todoNotes to item 2 of argv
  end if
  set todoWhen to ""
  if (count of argv) is greater than or equal to 3 then
    set todoWhen to item 3 of argv
  end if
  set todoDeadline to ""
  if (count of argv) is greater than or equal to 4 then
    set todoDeadline to item 4 of argv
  end if
  set todoTags to ""
  if (count of argv) is greater than or equal to 5 then
    set todoTags to item 5 of argv
  end if

  tell application "Things3"
    set newTodo to make new to do at list "Inbox" with properties {name:todoTitle}
    if todoNotes is not "" then
      set notes of newTodo to todoNotes
    end if
    if todoTags is not "" then
      set tag names of newTodo to todoTags
    end if
    if todoDeadline is not "" then
      set parsedDue to my parseWhenOrDate(todoDeadline)
      if parsedDue is not missing value then
        set due date of newTodo to parsedDue
      end if
    end if
    if todoWhen is not "" then
      set parsedWhen to my parseWhenOrDate(todoWhen)
      if parsedWhen is not missing value then
        schedule newTodo for parsedWhen
      end if
    end if
    return id of newTodo
  end tell
end run
