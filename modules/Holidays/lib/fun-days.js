"use strict";

/*
 * The fun days: national days, pop-culture days, food and drink days, the
 * cultural and religious holidays that aren't days off, and the sky's own
 * dates. Jake asked for "all the holidays" on 2026-11-05. The federal ones
 * are in federal.js.
 *
 * Every entry is a rule, so the list never runs out of years. Fixed dates
 * are written as dates. "The third Sunday in July" is written as that.
 * Easter, Passover, Lunar New Year and Eid come from their own calendars (see
 * dates.js). Nothing is fetched.
 *
 * There are hundreds of registered "national days", most of them filler
 * ("National Sewing Machine Day"). These are the ones people actually
 * celebrate, plus a few that suit this house: radio, podcasts, video games.
 * Add a line to add a day. A name appears once in the list, and
 * `scripts/check-holidays.js` keeps it that way.
 */

const D = require("./dates");
const { toIcs, yearsAround } = require("./ics");

const { SUNDAY, MONDAY, WEDNESDAY, THURSDAY, FRIDAY, SATURDAY, utc, addDays, nthWeekday, onOrAfter } = D;

/* ------------------------------------------------------------------------ *
 * Rule builders. Each returns (year) => Date | Date[] | null.
 * ------------------------------------------------------------------------ */

const on = (month, day) => (y) => utc(y, month, day);
const nth = (month, weekday, n) => (y) => nthWeekday(y, month, weekday, n);
const last = (month, weekday) => nth(month, weekday, -1);
const fromEaster = (days) => (y) => addDays(D.easter(y), days);
const thanksgiving = (y) => nthWeekday(y, 11, THURSDAY, 4);
const fromThanksgiving = (days) => (y) => addDays(thanksgiving(y), days);
const laborDay = (y) => nthWeekday(y, 9, MONDAY, 1);
const dstStarts = (y) => nthWeekday(y, 3, SUNDAY, 2);
const hebrew = (month, day) => (y) => D.lunar("hebrew", y, month, day);
const chinese = (month, day) => (y) => D.lunar("chinese", y, String(month), day);
const islamic = (month, day) => (y) => D.lunar("islamic-umalqura", y, String(month), day);
const season = (which) => (y) => D.season(y, which);

/* Every Friday the 13th of the year. */
const friday13 = (y) => Array.from({ length: 12 }, (_, i) => utc(y, i + 1, 13))
  .filter((d) => d.getUTCDay() === FRIDAY);

/* The 256th day: 2^8, the most a byte counts to. */
const programmersDay = (y) => addDays(utc(y, 1, 1), 255);

/* The inauguration follows each presidential election year: 2025, 2029... */
const inauguration = (y) => (y % 4 === 1 ? utc(y, 1, 20) : null);

/*
 * Federal returns are due April 15, moved to the next business day past a
 * weekend or DC's Emancipation Day (April 16, itself observed on the nearest
 * weekday). That is why it fell on the 18th in 2022 and 2023.
 */
function taxDay (y) {
  const emancipation = (() => {
    const day = utc(y, 4, 16);
    if (day.getUTCDay() === SATURDAY) return addDays(day, -1);
    if (day.getUTCDay() === SUNDAY) return addDays(day, 1);
    return day;
  })();

  let due = utc(y, 4, 15);
  while ([SATURDAY, SUNDAY].includes(due.getUTCDay()) || due.getTime() === emancipation.getTime()) {
    due = addDays(due, 1);
  }
  return due;
}

/* Munich's Wiesn runs sixteen days and ends on the first Sunday in October. */
const oktoberfest = (y) => addDays(nthWeekday(y, 10, SUNDAY, 1), -15);

/* ------------------------------------------------------------------------ *
 * The list. [name, rule]. Fixed dates by month first, then the rules.
 * ------------------------------------------------------------------------ */

const DAYS = [
  /* January */
  ["National Bloody Mary Day", on(1, 1)],
  ["National Spaghetti Day", on(1, 4)],
  ["National Bird Day", on(1, 5)],
  ["National Bean Day", on(1, 6)],
  ["National Pun Day", on(1, 8)],
  ["National Bagel Day", on(1, 15)],
  ["National Popcorn Day", on(1, 19)],
  ["National Cheese Lovers Day", on(1, 20)],
  ["National Hugging Day", on(1, 21)],
  ["Squirrel Appreciation Day", on(1, 21)],
  ["National Hot Sauce Day", on(1, 22)],
  ["National Pie Day", on(1, 23)],
  ["National Compliment Day", on(1, 24)],
  ["National Peanut Butter Day", on(1, 24)],
  ["National Irish Coffee Day", on(1, 25)],
  ["Data Privacy Day", on(1, 28)],
  ["National Croissant Day", on(1, 30)],
  ["National Hot Chocolate Day", on(1, 31)],

  /* February */
  ["Groundhog Day", on(2, 2)],
  ["World Nutella Day", on(2, 5)],
  ["National Pizza Day", on(2, 9)],
  ["World Radio Day", on(2, 13)],
  ["Galentine's Day", on(2, 13)],
  ["Valentine's Day", on(2, 14)],
  ["Random Acts of Kindness Day", on(2, 17)],
  ["National Drink Wine Day", on(2, 18)],
  ["National Margarita Day", on(2, 22)],
  ["National Banana Bread Day", on(2, 23)],
  ["National Tortilla Chip Day", on(2, 24)],
  ["Pokémon Day", on(2, 27)],
  ["National Strawberry Day", on(2, 27)],
  ["Leap Day", (y) => (D.isLeap(y) ? utc(y, 2, 29) : null)],

  /* March */
  ["Read Across America Day", on(3, 2)],
  ["World Wildlife Day", on(3, 3)],
  ["National Moscow Mule Day", on(3, 3)],
  ["National Oreo Day", on(3, 6)],
  ["National Cereal Day", on(3, 7)],
  ["International Women's Day", on(3, 8)],
  ["Mario Day", on(3, 10)],
  ["Pi Day", on(3, 14)],
  ["National Potato Chip Day", on(3, 14)],
  ["St. Patrick's Day", on(3, 17)],
  ["National Puppy Day", on(3, 23)],
  ["National Cheesesteak Day", on(3, 24)],
  ["Tolkien Reading Day", on(3, 25)],
  ["World Backup Day", on(3, 31)],

  /* April */
  ["April Fools' Day", on(4, 1)],
  ["National Sourdough Bread Day", on(4, 1)],
  ["National Peanut Butter and Jelly Day", on(4, 2)],
  ["National Ramen Day", on(4, 4)],
  ["National Beer Day", on(4, 7)],
  ["World Health Day", on(4, 7)],
  ["National Siblings Day", on(4, 10)],
  ["National Pet Day", on(4, 11)],
  ["National Grilled Cheese Day", on(4, 12)],
  ["National Garlic Day", on(4, 19)],
  ["Earth Day", on(4, 22)],
  ["National Jelly Bean Day", on(4, 22)],
  ["World Book Day", on(4, 23)],
  ["Talk Like Shakespeare Day", on(4, 23)],
  ["National Picnic Day", on(4, 23)],
  ["World Penguin Day", on(4, 25)],
  ["National Pretzel Day", on(4, 26)],
  ["National Superhero Day", on(4, 28)],
  ["International Jazz Day", on(4, 30)],

  /* May */
  ["Star Wars Day", on(5, 4)],
  ["Cinco de Mayo", on(5, 5)],
  ["National Nurses Day", on(5, 6)],
  ["National Shrimp Day", on(5, 10)],
  ["National Apple Pie Day", on(5, 13)],
  ["National Hummus Day", on(5, 13)],
  ["National Chocolate Chip Day", on(5, 15)],
  ["National Mimosa Day", on(5, 16)],
  ["Towel Day", on(5, 25)],
  ["National Wine Day", on(5, 25)],
  ["National Hamburger Day", on(5, 28)],

  /* June */
  ["National Cheese Day", on(6, 4)],
  ["World Environment Day", on(6, 5)],
  ["National Best Friends Day", on(6, 8)],
  ["Ghostbusters Day", on(6, 8)],
  ["Superman Day", on(6, 12)],
  ["Flag Day", on(6, 14)],
  ["National Bourbon Day", on(6, 14)],
  ["National Lobster Day", on(6, 15)],
  ["International Sushi Day", on(6, 18)],
  ["National Martini Day", on(6, 19)],
  ["Make Music Day", on(6, 21)],
  ["National Selfie Day", on(6, 21)],
  ["National Onion Ring Day", on(6, 22)],
  ["Tau Day", on(6, 28)],
  ["National Camera Day", on(6, 29)],

  /* July */
  ["National Joke Day", on(7, 1)],
  ["National Fried Chicken Day", on(7, 6)],
  ["National Video Game Day", on(7, 8)],
  ["National Piña Colada Day", on(7, 10)],
  ["National Mojito Day", on(7, 11)],
  ["National French Fry Day", on(7, 13)],
  ["National Mac and Cheese Day", on(7, 14)],
  ["World Emoji Day", on(7, 17)],
  ["National Caviar Day", on(7, 18)],
  ["National Daiquiri Day", on(7, 19)],
  ["National Junk Food Day", on(7, 21)],
  ["Pi Approximation Day", on(7, 22)],
  ["National Hammock Day", on(7, 22)],
  ["National Cousins Day", on(7, 24)],
  ["National Tequila Day", on(7, 24)],
  ["Aunt and Uncle Day", on(7, 26)],
  ["National Chicken Wing Day", on(7, 29)],
  ["National Lasagna Day", on(7, 29)],
  ["National Cheesecake Day", on(7, 30)],
  ["National Avocado Day", on(7, 31)],
  ["Harry Potter's Birthday", on(7, 31)],

  /* August */
  ["National Ice Cream Sandwich Day", on(8, 2)],
  ["National Watermelon Day", on(8, 3)],
  ["National Chocolate Chip Cookie Day", on(8, 4)],
  ["International Cat Day", on(8, 8)],
  ["National Book Lovers Day", on(8, 9)],
  ["National S'mores Day", on(8, 10)],
  ["National Lazy Day", on(8, 10)],
  ["National Vinyl Record Day", on(8, 12)],
  ["National Middle Child Day", on(8, 12)],
  ["International Left-Handers Day", on(8, 13)],
  ["National Relaxation Day", on(8, 15)],
  ["National Rum Day", on(8, 16)],
  ["National Tell a Joke Day", on(8, 16)],
  ["World Photography Day", on(8, 19)],
  ["National Radio Day", on(8, 20)],
  ["National Waffle Day", on(8, 24)],
  ["National Dog Day", on(8, 26)],
  ["National Mai Tai Day", on(8, 30)],

  /* September */
  ["Back to Hogwarts Day", on(9, 1)],
  ["National Cheese Pizza Day", on(9, 5)],
  ["National Beer Lovers Day", on(9, 7)],
  ["Star Trek Day", on(9, 8)],
  ["Patriot Day", on(9, 11)],
  ["National Guacamole Day", on(9, 16)],
  ["Constitution Day", on(9, 17)],
  ["National Cheeseburger Day", on(9, 18)],
  ["Talk Like a Pirate Day", on(9, 19)],
  ["National Queso Day", on(9, 20)],
  ["National Pepperoni Pizza Day", on(9, 20)],
  ["Hobbit Day", on(9, 22)],
  ["National Ice Cream Cone Day", on(9, 22)],
  ["National Punctuation Day", on(9, 24)],
  ["National Comic Book Day", on(9, 25)],
  ["National Daughters Day", on(9, 25)],
  ["National Pancake Day", on(9, 26)],
  ["National Dumpling Day", on(9, 26)],
  ["National Chocolate Milk Day", on(9, 27)],
  ["National Sons Day", on(9, 28)],
  ["National Coffee Day", on(9, 29)],
  ["International Podcast Day", on(9, 30)],

  /* October */
  ["National Taco Day", on(10, 4)],
  ["National Vodka Day", on(10, 4)],
  ["World Mental Health Day", on(10, 10)],
  ["National Coming Out Day", on(10, 11)],
  ["Boss's Day", on(10, 16)],
  ["National Pasta Day", on(10, 17)],
  ["International Sloth Day", on(10, 20)],
  ["Back to the Future Day", on(10, 21)],
  ["Mole Day", on(10, 23)],
  ["National Pumpkin Day", on(10, 26)],
  ["National Black Cat Day", on(10, 27)],
  ["National Chocolate Day", on(10, 28)],
  ["National Cat Day", on(10, 29)],
  ["National Candy Corn Day", on(10, 30)],
  ["Halloween", on(10, 31)],

  /* November */
  ["Día de los Muertos", on(11, 2)],
  ["National Sandwich Day", on(11, 3)],
  ["National Nacho Day", on(11, 6)],
  ["National Sundae Day", on(11, 11)],
  ["World Kindness Day", on(11, 13)],
  ["National Hiking Day", on(11, 17)],
  ["International Men's Day", on(11, 19)],
  ["World Television Day", on(11, 21)],
  ["National Cashew Day", on(11, 22)],
  ["Fibonacci Day", on(11, 23)],
  ["Doctor Who Day", on(11, 23)],
  ["National Espresso Day", on(11, 23)],
  ["National French Toast Day", on(11, 28)],

  /* December */
  ["National Cookie Day", on(12, 4)],
  ["Day of the Ninja", on(12, 5)],
  ["Pearl Harbor Remembrance Day", on(12, 7)],
  ["National Brownie Day", on(12, 8)],
  ["National Horse Day", on(12, 13)],
  ["National Cocoa Day", on(12, 13)],
  ["National Cupcake Day", on(12, 15)],
  ["National Sangria Day", on(12, 20)],
  ["Festivus", on(12, 23)],
  ["Christmas Eve", on(12, 24)],
  ["National Eggnog Day", on(12, 24)],
  ["Kwanzaa begins", on(12, 26)],
  ["National Candy Cane Day", on(12, 26)],
  ["National Fruitcake Day", on(12, 27)],
  ["National Bacon Day", on(12, 30)],
  ["New Year's Eve", on(12, 31)],
  ["National Champagne Day", on(12, 31)],

  /* Days that are "the nth weekday of a month" */
  ["National Chili Day", nth(2, THURSDAY, 4)],
  ["National Burrito Day", nth(4, THURSDAY, 1)],
  ["National High Five Day", nth(4, THURSDAY, 3)],
  ["Take Your Child to Work Day", nth(4, THURSDAY, 4)],
  ["Arbor Day", last(4, FRIDAY)],
  ["Free Comic Book Day", nth(5, SATURDAY, 1)],
  ["Mother's Day", nth(5, SUNDAY, 2)],
  ["Bike to Work Day", nth(5, FRIDAY, 3)],
  ["National Pizza Party Day", nth(5, FRIDAY, 3)],
  ["World Whisky Day", nth(5, SATURDAY, 3)],
  ["National Donut Day", nth(6, FRIDAY, 1)],
  ["National Trails Day", nth(6, SATURDAY, 1)],
  ["World Gin Day", nth(6, SATURDAY, 2)],
  ["Father's Day", nth(6, SUNDAY, 3)],
  ["National Hot Dog Day", nth(7, WEDNESDAY, 3)],
  ["National Ice Cream Day", nth(7, SUNDAY, 3)],
  ["Parents' Day", nth(7, SUNDAY, 4)],
  ["Sysadmin Day", last(7, FRIDAY)],
  ["International Beer Day", nth(8, FRIDAY, 1)],
  ["National Mustard Day", nth(8, SATURDAY, 1)],
  ["Friendship Day", nth(8, SUNDAY, 1)],
  ["National Honey Bee Day", nth(8, SATURDAY, 3)],
  ["National Cabernet Day", (y) => addDays(laborDay(y), -4)],
  ["Grandparents Day", (y) => addDays(laborDay(y), 6)],
  ["Batman Day", nth(9, SATURDAY, 3)],
  ["Public Lands Day", nth(9, SATURDAY, 4)],
  ["Oktoberfest begins", oktoberfest],
  ["World Smile Day", nth(10, FRIDAY, 1)],
  ["Indigenous Peoples' Day", nth(10, MONDAY, 2)],
  ["Sweetest Day", nth(10, SATURDAY, 3)],

  /* Around Thanksgiving */
  ["Black Friday", fromThanksgiving(1)],
  ["Small Business Saturday", fromThanksgiving(2)],
  ["Cyber Monday", fromThanksgiving(4)],
  ["Giving Tuesday", fromThanksgiving(5)],

  /* Civic */
  ["Inauguration Day", inauguration],
  ["Tax Day", taxDay],
  ["Election Day", (y) => addDays(nthWeekday(y, 11, MONDAY, 1), 1)],

  /* The clocks and the sky */
  ["Daylight saving time starts", dstStarts],
  ["National Napping Day", (y) => addDays(dstStarts(y), 1)],
  ["Daylight saving time ends", nth(11, SUNDAY, 1)],
  ["First day of spring", season("march")],
  ["First day of summer", season("june")],
  ["First day of fall", season("september")],
  ["First day of winter", season("december")],
  ["Friday the 13th", friday13],
  ["Programmers' Day", programmersDay],

  /* Easter and the days that hang off it (Western churches) */
  ["Mardi Gras", fromEaster(-47)],
  ["Ash Wednesday", fromEaster(-46)],
  ["Palm Sunday", fromEaster(-7)],
  ["Good Friday", fromEaster(-2)],
  ["Easter", fromEaster(0)],

  /* Hebrew calendar. Each begins at sundown the evening before. */
  ["Rosh Hashanah", hebrew("Tishri", 1)],
  ["Yom Kippur", hebrew("Tishri", 10)],
  ["Sukkot", hebrew("Tishri", 15)],
  ["First day of Hanukkah", hebrew("Kislev", 25)],
  ["Purim", hebrew(["Adar", "Adar II"], 14)],
  ["First day of Passover", hebrew("Nisan", 15)],

  /* Chinese calendar */
  ["Lunar New Year", chinese(1, 1)],
  ["Mid-Autumn Festival", chinese(8, 15)],

  /* Islamic calendar (Umm al-Qura). Local moon sighting can move these a day. */
  ["First day of Ramadan", islamic(9, 1)],
  ["Eid al-Fitr", islamic(10, 1)],
  ["Eid al-Adha", islamic(12, 10)]
];

/**
 * One year's fun days, in date order.
 *
 * @param {number} year
 * @returns {{date: Date, name: string}[]}
 */
function funDaysOf (year) {
  const days = [];

  for (const [name, rule] of DAYS) {
    for (const date of [].concat(rule(year) ?? [])) {
      if (date.getUTCFullYear() === year) days.push({ date, name });
    }
  }

  return days.sort((a, b) => a.date - b.date);
}

/**
 * The feed the "fun" calendar fetches. Last year to next year, like the
 * federal one.
 *
 * @param {Date} [now]
 * @returns {string}
 */
function calendar (now = new Date()) {
  return toIcs({
    name: "National Days",
    uidTag: "fun",
    days: yearsAround(now).flatMap(funDaysOf)
  });
}

module.exports = {
  /* Where the node_helper serves it. config.js points the "fun" calendar here. */
  FEED_PATH: "/holidays/fun-days.ics",
  DAYS,
  funDaysOf,
  calendar,
  taxDay,
  oktoberfest
};
