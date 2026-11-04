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
  if (count of argv) is less than 2 then return ""
  set todoId to item 1 of argv
  set theWhen to item 2 of argv
  tell application "Things3"
    set t to to do id todoId
    set parsedWhen to my parseWhenOrDate(theWhen)
    if parsedWhen is not missing value then
      schedule t for parsedWhen
    end if
    return id of t
  end tell
end run
