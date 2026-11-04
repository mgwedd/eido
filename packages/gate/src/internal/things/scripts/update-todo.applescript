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
  set todoId to item 1 of argv
  set keep to "__EIDO_KEEP__"

  set theTitle to keep
  if (count of argv) is greater than or equal to 2 then set theTitle to item 2 of argv
  set theNotes to keep
  if (count of argv) is greater than or equal to 3 then set theNotes to item 3 of argv
  set theWhen to keep
  if (count of argv) is greater than or equal to 4 then set theWhen to item 4 of argv
  set theDeadline to keep
  if (count of argv) is greater than or equal to 5 then set theDeadline to item 5 of argv
  set theTags to keep
  if (count of argv) is greater than or equal to 6 then set theTags to item 6 of argv
  set theList to keep
  if (count of argv) is greater than or equal to 7 then set theList to item 7 of argv
  set theProject to keep
  if (count of argv) is greater than or equal to 8 then set theProject to item 8 of argv
  set theArea to keep
  if (count of argv) is greater than or equal to 9 then set theArea to item 9 of argv

  tell application "Things3"
    set t to to do id todoId
    if theTitle is not keep then
      set name of t to theTitle
    end if
    if theNotes is not keep then
      set notes of t to theNotes
    end if
    if theTags is not keep then
      set tag names of t to theTags
    end if
    if theDeadline is not keep then
      if theDeadline is "" or theDeadline is "clear" then
        set due date of t to missing value
      else
        set parsedDue to my parseWhenOrDate(theDeadline)
        if parsedDue is not missing value then
          set due date of t to parsedDue
        end if
      end if
    end if
    if theWhen is not keep and theWhen is not "" then
      set parsedWhen to my parseWhenOrDate(theWhen)
      if parsedWhen is not missing value then
        schedule t for parsedWhen
      end if
    end if
    if theProject is not keep and theProject is not "" then
      try
        set project of t to project theProject
      on error
        try
          set project of t to project id theProject
        end try
      end try
    end if
    if theArea is not keep and theArea is not "" then
      try
        set area of t to area theArea
      on error
        try
          set area of t to area id theArea
        end try
      end try
    end if
    if theList is not keep and theList is not "" then
      try
        move t to list theList
      end try
    end if
    return id of t
  end tell
end run
