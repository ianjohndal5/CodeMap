<?php

if (! function_exists('format_report_date')) {
    function format_report_date(): string
    {
        return now_iso();
    }
}

function now_iso(): string
{
    return date(DATE_ATOM);
}
